import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Document, DocumentCategory, DocumentStatus, Prisma, Role } from '@prisma/client';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AuthUser, isStaff } from '../common/types';
import { detectFileType } from './file-type';

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  IDENTITY: 'Documentos de identidad',
  BANKING: 'Documentos bancarios',
  LEGAL: 'Documentos legales',
  RECEIPT: 'Comprobantes',
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async upload(user: AuthUser, file: Express.Multer.File | undefined, input: { category: DocumentCategory; disbursementId?: string; caseId?: string }) {
    if (!file) throw new BadRequestException('Adjunta un archivo en el campo "file"');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('El archivo supera el máximo de 10 MB');

    // Validación inmediata: el tipo se determina por el contenido real del archivo.
    const detected = detectFileType(file.buffer);
    if (!detected) throw new BadRequestException('Formato no permitido. Sube un PDF, JPG o PNG válido');

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = await this.prisma.document.findFirst({ where: { ownerId: user.id, sha256, category: input.category }, select: { id: true } });
    if (duplicate) throw new ConflictException('Ya cargaste este mismo archivo en esta categoría');

    if (input.disbursementId) {
      const own = await this.prisma.disbursementRequest.findFirst({ where: { id: input.disbursementId, clientId: user.id }, select: { id: true } });
      if (!own) throw new NotFoundException('Solicitud de desembolso no encontrada');
    }
    if (input.caseId) {
      const own = await this.prisma.case.findFirst({ where: { id: input.caseId, clientId: user.id }, select: { id: true } });
      if (!own) throw new NotFoundException('Caso no encontrado');
    }

    const originalName = file.originalname ? Buffer.from(file.originalname, 'latin1').toString('utf8') : `documento${detected.extension}`;
    const storageKey = await this.storage.save(user.id, file.buffer, detected.extension);
    const doc = await this.prisma.document.create({
      data: {
        ownerId: user.id,
        category: input.category,
        originalName: originalName.replace(/[\\/\r\n]/g, '_').slice(0, 200),
        storageKey,
        mimeType: detected.mime,
        size: file.size,
        sha256,
        disbursementId: input.disbursementId,
        caseId: input.caseId,
      },
    });
    await this.audit.log({ actor: user, action: 'DOCUMENT_UPLOADED', entity: 'Document', entityId: doc.id, metadata: { category: doc.category, size: doc.size } });
    return this.present(doc);
  }

  present(doc: Document) {
    const { storageKey: _storageKey, sha256: _sha256, ...rest } = doc;
    return rest;
  }

  async listOwn(userId: string, category?: DocumentCategory) {
    const all = await this.prisma.document.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'desc' } });
    const items = all.filter((d) => !category || d.category === category).map((d) => this.present(d));
    const summary = (Object.keys(CATEGORY_LABELS) as DocumentCategory[]).map((cat) => {
      const docs = all.filter((d) => d.category === cat);
      return {
        category: cat,
        label: CATEGORY_LABELS[cat],
        total: docs.length,
        pending: docs.filter((d) => d.status === DocumentStatus.PENDING).length,
        validated: docs.filter((d) => d.status === DocumentStatus.VALIDATED).length,
        rejected: docs.filter((d) => d.status === DocumentStatus.REJECTED).length,
      };
    });
    return { items, summary };
  }

  private async getAccessible(user: AuthUser, id: string): Promise<Document> {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    // Un cliente no debe poder distinguir "no existe" de "no es tuyo".
    if (!doc || (!isStaff(user) && doc.ownerId !== user.id)) throw new NotFoundException('Documento no encontrado');
    return doc;
  }

  async download(user: AuthUser, id: string) {
    const doc = await this.getAccessible(user, id);
    if (doc.ownerId !== user.id) {
      await this.audit.log({ actor: user, action: 'DOCUMENT_DOWNLOADED', entity: 'Document', entityId: doc.id, metadata: { ownerId: doc.ownerId } });
    }
    return new StreamableFile(this.storage.stream(doc.storageKey), {
      type: doc.mimeType,
      length: doc.size,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`,
    });
  }

  async remove(user: AuthUser, id: string) {
    const doc = await this.getAccessible(user, id);
    const isOwner = doc.ownerId === user.id;
    if (user.role !== Role.SUPERADMIN) {
      if (!isOwner) throw new ForbiddenException('No puedes eliminar documentos de otros usuarios');
      if (doc.status === DocumentStatus.VALIDATED) {
        throw new ForbiddenException('Un documento validado no puede eliminarse. Contacta a tu abogado si necesitas reemplazarlo');
      }
    }
    await this.prisma.document.delete({ where: { id } });
    await this.storage.remove(doc.storageKey);
    await this.audit.log({ actor: user, action: 'DOCUMENT_DELETED', entity: 'Document', entityId: id, metadata: { ownerId: doc.ownerId, status: doc.status } });
    return { ok: true };
  }

  async review(actor: AuthUser, id: string, decision: 'VALIDATED' | 'REJECTED', reason?: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    if (doc.status === decision) throw new BadRequestException('El documento ya tiene ese estado');
    if (decision === 'REJECTED' && !reason?.trim()) throw new BadRequestException('Indica el motivo del rechazo');

    const updated = await this.prisma.document.update({
      where: { id },
      data: {
        status: decision,
        rejectionReason: decision === 'REJECTED' ? reason!.trim() : null,
        reviewedById: actor.id,
        reviewedAt: new Date(),
      },
    });
    await this.audit.log({ actor, action: decision === 'VALIDATED' ? 'DOCUMENT_VALIDATED' : 'DOCUMENT_REJECTED', entity: 'Document', entityId: id, metadata: { from: doc.status, reason: reason ?? null } });

    const label = CATEGORY_LABELS[doc.category];
    await this.notifications.notify(doc.ownerId, {
      type: 'DOCUMENT',
      title: decision === 'VALIDATED' ? 'Documento validado' : 'Documento rechazado',
      body:
        decision === 'VALIDATED'
          ? `Tu documento "${doc.originalName}" (${label}) fue validado.`
          : `Tu documento "${doc.originalName}" (${label}) fue rechazado: ${reason!.trim()}. Sube una versión corregida.`,
      link: '/dashboard/documentos',
    });
    return this.present(updated);
  }

  async listForStaff(q: { status?: DocumentStatus; category?: DocumentCategory; ownerId?: string; search?: string }, skip: number, take: number) {
    const where: Prisma.DocumentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.ownerId ? { ownerId: q.ownerId } : {}),
      ...(q.search
        ? { OR: [{ originalName: { contains: q.search, mode: 'insensitive' } }, { owner: { fullName: { contains: q.search, mode: 'insensitive' } } }, { owner: { email: { contains: q.search, mode: 'insensitive' } } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: q.status === DocumentStatus.PENDING ? 'asc' : 'desc' },
        skip,
        take,
        include: { owner: { select: { id: true, fullName: true, email: true } }, reviewedBy: { select: { fullName: true } } },
      }),
      this.prisma.document.count({ where }),
    ]);
    const items = rows.map(({ storageKey: _k, sha256: _s, ...doc }) => doc);
    return { items, total };
  }
}
