import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { detectImageType } from '../content/image-type';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;
export const MAX_VERSION_BYTES = 30 * 1024 * 1024;
const MAX_EDITS = 100;

export type TextEdit = { x: number; y: number; w: number; h: number; text: string; font: string; size: number; color: string; bold: boolean; italic: boolean; align: 'left' | 'center' | 'right' };

const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const safeName = (name: string) => name.replace(/[\\/\r\n"]/g, '_').slice(0, 120);

/** Valida la lista de ediciones que envía el editor (se guarda para poder reproducirlas). */
export function parseEdits(raw: unknown): TextEdit[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BadRequestException('El historial de ediciones no es un JSON válido');
    }
  }
  if (!Array.isArray(value) || value.length > MAX_EDITS) throw new BadRequestException(`Las ediciones deben ser una lista de hasta ${MAX_EDITS} elementos`);
  const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  return value.map((e: Record<string, unknown>) => {
    const ok =
      e && num(e.x, -1e5, 1e5) && num(e.y, -1e5, 1e5) && num(e.w, 1, 1e5) && num(e.h, 1, 1e5) && num(e.size, 1, 5000) &&
      typeof e.text === 'string' && e.text.length <= 300 && typeof e.font === 'string' && e.font.length <= 60 &&
      typeof e.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(e.color) && typeof e.bold === 'boolean' && typeof e.italic === 'boolean' &&
      ['left', 'center', 'right'].includes(e.align as string);
    if (!ok) throw new BadRequestException('Alguna edición tiene datos inválidos');
    return e as unknown as TextEdit;
  });
}

/**
 * Editor de imágenes para piezas gráficas propias del despacho. El original es inmutable: cada edición se guarda como una
 * versión nueva con su autor, fecha y huella (SHA-256) del original y del resultado; todo queda en la auditoría.
 */
@Injectable()
export class StudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async upload(actor: AuthUser, file: Express.Multer.File | undefined, title?: string) {
    if (!file?.buffer?.length) throw new BadRequestException('Adjunta una imagen');
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException('Formato no admitido. Usa una imagen JPG, PNG o WebP');
    const originalName = safeName(file.originalname ? Buffer.from(file.originalname, 'latin1').toString('utf8') : `imagen${type.extension}`);
    const key = await this.storage.save('studio', file.buffer, type.extension);
    const image = await this.prisma.studioImage.create({
      data: {
        title: (title?.trim() || originalName.replace(/\.[^.]+$/, '')).slice(0, 160),
        originalName, originalKey: key, originalMime: type.mime, originalSize: file.buffer.length, originalSha256: sha256(file.buffer),
        createdById: actor.id, createdByEmail: actor.email,
      },
    });
    await this.audit.log({ actor, action: 'STUDIO_IMAGE_UPLOADED', entity: 'StudioImage', entityId: image.id, metadata: { sha256: image.originalSha256, size: image.originalSize, name: originalName } });
    return this.summary(image, 0, null);
  }

  async list() {
    const images = await this.prisma.studioImage.findMany({
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } }, _count: { select: { versions: true } } },
    });
    return images.map((i) => this.summary(i, i._count.versions, i.versions[0]?.id ?? null));
  }

  async detail(id: string) {
    const image = await this.prisma.studioImage.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!image) throw new NotFoundException('Imagen no encontrada');
    return {
      ...this.summary(image, image.versions.length, image.versions[0]?.id ?? null),
      originalSha256: image.originalSha256,
      versions: image.versions.map((v) => ({ id: v.id, version: v.version, label: v.label, size: v.size, sha256: v.sha256, edits: v.edits, createdAt: v.createdAt, createdByEmail: v.createdByEmail })),
    };
  }

  async original(id: string) {
    const image = await this.prisma.studioImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Imagen no encontrada');
    return new StreamableFile(this.storage.stream(image.originalKey), { type: image.originalMime, length: image.originalSize, disposition: 'inline' });
  }

  async saveVersion(actor: AuthUser, imageId: string, file: Express.Multer.File | undefined, label: string | undefined, editsRaw: unknown) {
    const image = await this.prisma.studioImage.findUnique({ where: { id: imageId } });
    if (!image) throw new NotFoundException('Imagen no encontrada');
    if (!file?.buffer?.length) throw new BadRequestException('Adjunta la imagen editada');
    if (file.buffer.length > MAX_VERSION_BYTES) throw new BadRequestException('La imagen editada es demasiado grande');
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException('Formato no admitido. La imagen editada debe ser JPG, PNG o WebP');
    const edits = parseEdits(editsRaw ?? '[]');

    const key = await this.storage.save('studio', file.buffer, type.extension);
    try {
      const version = await this.prisma.$transaction(async (tx) => {
        const last = await tx.studioVersion.aggregate({ where: { imageId }, _max: { version: true } });
        const number = (last._max.version ?? 0) + 1;
        return tx.studioVersion.create({
          data: {
            imageId, version: number, label: (label?.trim() || `Versión ${number}`).slice(0, 120), key, mime: type.mime, size: file.buffer.length, sha256: sha256(file.buffer),
            edits: edits as unknown as Prisma.InputJsonValue, createdById: actor.id, createdByEmail: actor.email,
          },
        });
      });
      await this.audit.log({ actor, action: 'STUDIO_VERSION_SAVED', entity: 'StudioImage', entityId: imageId, metadata: { version: version.version, edits: edits.length, sha256: version.sha256, originalSha256: image.originalSha256 } });
      return { id: version.id, version: version.version, label: version.label, size: version.size, createdAt: version.createdAt };
    } catch (e) {
      await this.storage.remove(key);
      throw e;
    }
  }

  async version(actor: AuthUser, id: string, download: boolean) {
    const version = await this.prisma.studioVersion.findUnique({ where: { id }, include: { image: { select: { id: true, title: true } } } });
    if (!version) throw new NotFoundException('Versión no encontrada');
    if (download) {
      await this.audit.log({ actor, action: 'STUDIO_VERSION_DOWNLOADED', entity: 'StudioImage', entityId: version.image.id, metadata: { version: version.version, sha256: version.sha256 } });
    }
    const ext = version.mime === 'image/jpeg' ? 'jpg' : version.mime === 'image/webp' ? 'webp' : 'png';
    const filename = `${safeName(version.image.title)}-v${version.version}.${ext}`;
    return new StreamableFile(this.storage.stream(version.key), {
      type: version.mime, length: version.size, disposition: `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
  }

  async remove(actor: AuthUser, id: string) {
    const image = await this.prisma.studioImage.findUnique({ where: { id }, include: { versions: { select: { key: true } } } });
    if (!image) throw new NotFoundException('Imagen no encontrada');
    await this.prisma.studioImage.delete({ where: { id } });
    await Promise.all([image.originalKey, ...image.versions.map((v) => v.key)].map((k) => this.storage.remove(k)));
    await this.audit.log({ actor, action: 'STUDIO_IMAGE_DELETED', entity: 'StudioImage', entityId: id, metadata: { title: image.title, versions: image.versions.length, originalSha256: image.originalSha256 } });
    return { ok: true };
  }

  private summary(i: { id: string; title: string; originalName: string; originalMime: string; originalSize: number; createdAt: Date; createdByEmail: string | null }, versionCount: number, latestVersionId: string | null) {
    return { id: i.id, title: i.title, originalName: i.originalName, mime: i.originalMime, size: i.originalSize, createdAt: i.createdAt, createdByEmail: i.createdByEmail, versionCount, latestVersionId };
  }
}
