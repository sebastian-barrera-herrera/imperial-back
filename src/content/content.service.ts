import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateTeamDto, CreateTestimonialDto, UpdateTeamDto, UpdateTestimonialDto } from './dto';
import { detectImageType } from './image-type';
import { SAMPLE_TEAM, SAMPLE_TESTIMONIALS } from './samples';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ORDER = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];
const STALE_IMAGE_MS = 24 * 60 * 60 * 1000;

type Section = 'team' | 'testimonials';
const publicImage = (id: string | null) => (id ? `/api/public/content/images/${id}` : null);
const adminImage = (id: string | null) => (id ? `/api/admin/content/images/${id}` : null);

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Público ─────────────

  /** `null` en una sección significa «aún no configurada»: el sitio usa su contenido de respaldo. */
  async publicContent() {
    const [teamTotal, testimonialTotal] = await Promise.all([this.prisma.teamMember.count(), this.prisma.testimonial.count()]);
    const [team, testimonials] = await Promise.all([
      teamTotal === 0 ? null : this.prisma.teamMember.findMany({ where: { published: true }, orderBy: ORDER }),
      testimonialTotal === 0 ? null : this.prisma.testimonial.findMany({ where: { published: true }, orderBy: ORDER }),
    ]);
    return {
      team: team?.map((m) => ({ id: m.id, name: m.name, role: m.role, bio: m.bio, photoUrl: publicImage(m.photoId), isSample: m.isSample })) ?? null,
      testimonials: testimonials?.map((t) => ({ id: t.id, quote: t.quote, author: t.author, kind: t.kind, photoUrl: publicImage(t.photoId), isSample: t.isSample })) ?? null,
    };
  }

  /** Una foto es pública solo mientras la use algún elemento publicado. */
  async publicImage(id: string) {
    const image = await this.prisma.contentImage.findFirst({
      where: { id, OR: [{ teamMembers: { some: { published: true } } }, { testimonials: { some: { published: true } } }] },
    });
    if (!image) throw new NotFoundException('Imagen no encontrada');
    return { stream: this.storage.stream(image.key), mime: image.mime };
  }

  // ───────────── Superadmin ─────────────

  async adminContent() {
    const [team, testimonials] = await Promise.all([
      this.prisma.teamMember.findMany({ orderBy: ORDER }),
      this.prisma.testimonial.findMany({ orderBy: ORDER }),
    ]);
    const meta = (x: { isSample: boolean; authorizedAt: Date | null; authorizedBy: string | null; photoId: string | null; published: boolean; sortOrder: number }) => ({
      isSample: x.isSample, authorized: !x.isSample && x.authorizedAt !== null, authorizedAt: x.authorizedAt, authorizedBy: x.authorizedBy,
      photoUrl: adminImage(x.photoId), published: x.published, sortOrder: x.sortOrder,
    });
    return {
      team: team.map((m) => ({ id: m.id, name: m.name, role: m.role, bio: m.bio, ...meta(m) })),
      testimonials: testimonials.map((t) => ({ id: t.id, quote: t.quote, author: t.author, kind: t.kind, ...meta(t) })),
    };
  }

  async adminImage(id: string) {
    const image = await this.prisma.contentImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Imagen no encontrada');
    return { stream: this.storage.stream(image.key), mime: image.mime };
  }

  async uploadImage(actor: AuthUser, file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Adjunta una imagen');
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException('Formato no admitido. Usa una imagen JPG, PNG o WebP');
    const key = await this.storage.save('content', file.buffer, type.extension);
    const image = await this.prisma.contentImage.create({ data: { key, mime: type.mime, size: file.buffer.length, uploadedById: actor.id } });
    await this.audit.log({ actor, action: 'CONTENT_IMAGE_UPLOADED', entity: 'ContentImage', entityId: image.id, metadata: { mime: type.mime, size: image.size } });
    void this.purgeUnattached(); // limpieza oportunista de subidas que nunca se asociaron a un perfil
    return { id: image.id, url: adminImage(image.id) };
  }

  async createTeam(actor: AuthUser, dto: CreateTeamDto) {
    this.requireAuthorization(dto.authorized, 'que esta persona es real y autorizó publicar su nombre y foto');
    await this.assertImage(dto.photoId);
    const member = await this.prisma.teamMember.create({
      data: { name: dto.name, role: dto.role, bio: dto.bio, photoId: dto.photoId, published: dto.published ?? true, sortOrder: await this.nextOrder('team'), authorizedAt: new Date(), authorizedBy: actor.email },
    });
    await this.audit.log({ actor, action: 'CONTENT_CREATED', entity: 'TeamMember', entityId: member.id, metadata: { name: member.name } });
    return { id: member.id };
  }

  async updateTeam(actor: AuthUser, id: string, dto: UpdateTeamDto) {
    const current = await this.prisma.teamMember.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Perfil no encontrado');
    if (dto.photoId) await this.assertImage(dto.photoId);

    const identityChanged = (dto.name !== undefined && dto.name !== current.name) || (dto.photoId !== undefined && dto.photoId !== current.photoId);
    const textChanged = (dto.role !== undefined && dto.role !== current.role) || (dto.bio !== undefined && dto.bio !== current.bio);
    // Reemplazar un ejemplo o cambiar la identidad (nombre/foto) exige confirmar de nuevo la autorización.
    const needsAuthorization = identityChanged || (current.isSample && textChanged);
    if (needsAuthorization) this.requireAuthorization(dto.authorized, 'que esta persona es real y autorizó publicar su nombre y foto');

    const data: Prisma.TeamMemberUncheckedUpdateInput = { name: dto.name, role: dto.role, bio: dto.bio, photoId: dto.photoId, published: dto.published };
    if (needsAuthorization) Object.assign(data, { isSample: false, authorizedAt: new Date(), authorizedBy: actor.email });
    await this.prisma.teamMember.update({ where: { id }, data });
    if (dto.photoId !== undefined && current.photoId && dto.photoId !== current.photoId) await this.releaseImage(current.photoId);
    await this.audit.log({ actor, action: 'CONTENT_UPDATED', entity: 'TeamMember', entityId: id, metadata: { fields: Object.keys(dto).filter((k) => k !== 'authorized') } });
    return { id };
  }

  async removeTeam(actor: AuthUser, id: string) {
    const current = await this.prisma.teamMember.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Perfil no encontrado');
    await this.prisma.teamMember.delete({ where: { id } });
    if (current.photoId) await this.releaseImage(current.photoId);
    await this.audit.log({ actor, action: 'CONTENT_DELETED', entity: 'TeamMember', entityId: id, metadata: { name: current.name } });
    return { ok: true };
  }

  async createTestimonial(actor: AuthUser, dto: CreateTestimonialDto) {
    this.requireAuthorization(dto.authorized, 'que tienes autorización escrita de esta persona para publicar su testimonio, nombre y foto');
    await this.assertImage(dto.photoId);
    const item = await this.prisma.testimonial.create({
      data: { quote: dto.quote, author: dto.author, kind: dto.kind, photoId: dto.photoId, published: dto.published ?? true, sortOrder: await this.nextOrder('testimonials'), authorizedAt: new Date(), authorizedBy: actor.email },
    });
    await this.audit.log({ actor, action: 'CONTENT_CREATED', entity: 'Testimonial', entityId: item.id, metadata: { author: item.author } });
    return { id: item.id };
  }

  async updateTestimonial(actor: AuthUser, id: string, dto: UpdateTestimonialDto) {
    const current = await this.prisma.testimonial.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Testimonio no encontrado');
    if (dto.photoId) await this.assertImage(dto.photoId);

    // Cualquier cambio de contenido (la cita, quién la dice o su foto) exige confirmar de nuevo la autorización:
    // no se puede alterar lo que dijo una persona sin que ella lo haya autorizado.
    const contentChanged =
      (dto.quote !== undefined && dto.quote !== current.quote) || (dto.author !== undefined && dto.author !== current.author) ||
      (dto.kind !== undefined && dto.kind !== current.kind) || (dto.photoId !== undefined && dto.photoId !== current.photoId);
    if (contentChanged) this.requireAuthorization(dto.authorized, 'que tienes autorización escrita de esta persona para publicar este testimonio, su nombre y foto');

    const data: Prisma.TestimonialUncheckedUpdateInput = { quote: dto.quote, author: dto.author, kind: dto.kind, photoId: dto.photoId, published: dto.published };
    if (contentChanged) Object.assign(data, { isSample: false, authorizedAt: new Date(), authorizedBy: actor.email });
    await this.prisma.testimonial.update({ where: { id }, data });
    if (dto.photoId !== undefined && current.photoId && dto.photoId !== current.photoId) await this.releaseImage(current.photoId);
    await this.audit.log({ actor, action: 'CONTENT_UPDATED', entity: 'Testimonial', entityId: id, metadata: { fields: Object.keys(dto).filter((k) => k !== 'authorized') } });
    return { id };
  }

  async removeTestimonial(actor: AuthUser, id: string) {
    const current = await this.prisma.testimonial.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Testimonio no encontrado');
    await this.prisma.testimonial.delete({ where: { id } });
    if (current.photoId) await this.releaseImage(current.photoId);
    await this.audit.log({ actor, action: 'CONTENT_DELETED', entity: 'Testimonial', entityId: id, metadata: { author: current.author } });
    return { ok: true };
  }

  async reorder(actor: AuthUser, section: Section, ids: string[]) {
    const existing: { id: string }[] =
      section === 'team' ? await this.prisma.teamMember.findMany({ select: { id: true } }) : await this.prisma.testimonial.findMany({ select: { id: true } });
    const same = ids.length === existing.length && new Set(ids).size === ids.length && existing.every((e) => ids.includes(e.id));
    if (!same) throw new BadRequestException('La lista de orden debe incluir todos los elementos exactamente una vez');
    await this.prisma.$transaction(
      ids.map((id, i) => (section === 'team' ? this.prisma.teamMember.update({ where: { id }, data: { sortOrder: i } }) : this.prisma.testimonial.update({ where: { id }, data: { sortOrder: i } }))),
    );
    await this.audit.log({ actor, action: 'CONTENT_REORDERED', entity: section === 'team' ? 'TeamMember' : 'Testimonial' });
    return { ok: true };
  }

  /** Carga el contenido de ejemplo en las secciones que aún están vacías. */
  async importSamples(actor: AuthUser) {
    const [teamTotal, testimonialTotal] = await Promise.all([this.prisma.teamMember.count(), this.prisma.testimonial.count()]);
    if (teamTotal > 0 && testimonialTotal > 0) throw new ConflictException('Ya hay contenido cargado en ambas secciones');
    if (teamTotal === 0) await this.prisma.teamMember.createMany({ data: SAMPLE_TEAM.map((m, i) => ({ ...m, sortOrder: i, isSample: true })) });
    if (testimonialTotal === 0) await this.prisma.testimonial.createMany({ data: SAMPLE_TESTIMONIALS.map((t, i) => ({ ...t, sortOrder: i, isSample: true })) });
    await this.audit.log({ actor, action: 'CONTENT_SAMPLES_IMPORTED', entity: 'SiteContent' });
    return { team: teamTotal === 0 ? SAMPLE_TEAM.length : 0, testimonials: testimonialTotal === 0 ? SAMPLE_TESTIMONIALS.length : 0 };
  }

  // ───────────── Utilidades ─────────────

  private requireAuthorization(authorized: boolean | undefined, what: string) {
    if (authorized !== true) throw new BadRequestException(`Para guardar este cambio confirma ${what}`);
  }

  private async assertImage(id?: string | null) {
    if (!id) return;
    if (!(await this.prisma.contentImage.findUnique({ where: { id }, select: { id: true } }))) throw new BadRequestException('La foto indicada no existe. Vuelve a subirla');
  }

  private async nextOrder(section: Section): Promise<number> {
    const agg = section === 'team' ? await this.prisma.teamMember.aggregate({ _max: { sortOrder: true } }) : await this.prisma.testimonial.aggregate({ _max: { sortOrder: true } });
    return (agg._max.sortOrder ?? -1) + 1;
  }

  /** Borra la foto (archivo y registro) cuando ya nadie la usa. */
  private async releaseImage(id: string) {
    const image = await this.prisma.contentImage.findUnique({ where: { id }, include: { _count: { select: { teamMembers: true, testimonials: true } } } });
    if (!image || image._count.teamMembers + image._count.testimonials > 0) return;
    await this.prisma.contentImage.delete({ where: { id } });
    await this.storage.remove(image.key);
  }

  private async purgeUnattached() {
    try {
      const stale = await this.prisma.contentImage.findMany({
        where: { createdAt: { lt: new Date(Date.now() - STALE_IMAGE_MS) }, teamMembers: { none: {} }, testimonials: { none: {} } },
        take: 50,
      });
      for (const image of stale) {
        await this.prisma.contentImage.delete({ where: { id: image.id } });
        await this.storage.remove(image.key);
      }
    } catch {
      // Es solo una limpieza: nunca debe afectar a la subida.
    }
  }
}
