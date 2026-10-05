import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { IssuedDocumentCategory, Prisma, Role } from '@prisma/client';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { detectFileType } from '../documents/file-type';
import { MAX_UPLOAD_BYTES } from '../documents/documents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export const ISSUED_CATEGORY_LABELS: Record<IssuedDocumentCategory, string> = {
  CONTRACT: 'Contrato',
  RESOLUTION: 'Resolución o providencia',
  CERTIFICATE: 'Certificado o constancia',
  INVOICE: 'Factura o cuenta de cobro',
  REPORT: 'Informe',
  OTHER: 'Otro',
};

const select = {
  id: true, title: true, description: true, category: true, originalName: true, mimeType: true, size: true, createdAt: true, viewedAt: true,
  case: { select: { id: true, number: true } },
} satisfies Prisma.IssuedDocumentSelect;

/** Documentos que el despacho entrega al cliente (contratos, constancias, resoluciones…). */
@Injectable()
export class IssuedDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async upload(actor: AuthUser, clientId: string, file: Express.Multer.File | undefined, dto: { title: string; description?: string; category: IssuedDocumentCategory; caseId?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('Adjunta un archivo en el campo "file"');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('El archivo supera el máximo de 10 MB');
    const detected = detectFileType(file.buffer);
    if (!detected) throw new BadRequestException('Formato no permitido. Sube un PDF, JPG o PNG válido');

    const client = await this.prisma.user.findFirst({ where: { id: clientId, role: Role.CLIENT }, select: { id: true, fullName: true } });
    if (!client) throw new NotFoundException('Cliente no encontrado');
    if (dto.caseId && !(await this.prisma.case.findFirst({ where: { id: dto.caseId, clientId }, select: { id: true } }))) throw new NotFoundException('Caso no encontrado para este cliente');

    const originalName = file.originalname ? Buffer.from(file.originalname, 'latin1').toString('utf8') : `documento${detected.extension}`;
    const storageKey = await this.storage.save(`issued-${clientId}`, file.buffer, detected.extension);
    const doc = await this.prisma.issuedDocument.create({
      data: {
        clientId, uploadedById: actor.id, caseId: dto.caseId || undefined,
        title: dto.title.trim(), description: dto.description?.trim() || null, category: dto.category,
        originalName: originalName.replace(/[\\/\r\n]/g, '_').slice(0, 200), storageKey, mimeType: detected.mime, size: file.size,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
      },
      select,
    });
    await this.audit.log({ actor, action: 'ISSUED_DOCUMENT_UPLOADED', entity: 'IssuedDocument', entityId: doc.id, metadata: { clientId, category: dto.category, title: doc.title } });
    await this.notifications.notify(clientId, { type: 'DOCUMENT', title: 'Nuevo documento del despacho', body: doc.title, link: '/dashboard/documentos?tab=recibidos' });
    return doc;
  }

  /** Vista del superadmin: documentos entregados a un cliente. */
  async listForClient(clientId: string) {
    const client = await this.prisma.user.findFirst({ where: { id: clientId, role: Role.CLIENT }, select: { id: true, fullName: true, email: true } });
    if (!client) throw new NotFoundException('Cliente no encontrado');
    const [items, cases] = await Promise.all([
      this.prisma.issuedDocument.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, select }),
      this.prisma.case.findMany({ where: { clientId }, select: { id: true, number: true, title: true }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { client, cases, items };
  }

  /** Vista del cliente: solo lo que se le entregó a él. */
  listOwn(user: AuthUser) {
    return this.prisma.issuedDocument.findMany({ where: { clientId: user.id }, orderBy: { createdAt: 'desc' }, select });
  }

  async download(user: AuthUser, id: string) {
    const doc = await this.prisma.issuedDocument.findFirst({ where: { id, ...(user.role === Role.CLIENT ? { clientId: user.id } : {}) } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    if (user.role === Role.CLIENT) {
      if (!doc.viewedAt) await this.prisma.issuedDocument.update({ where: { id }, data: { viewedAt: new Date() } });
    } else {
      await this.audit.log({ actor: user, action: 'ISSUED_DOCUMENT_DOWNLOADED', entity: 'IssuedDocument', entityId: id, metadata: { clientId: doc.clientId } });
    }
    return new StreamableFile(this.storage.stream(doc.storageKey), {
      type: doc.mimeType,
      length: doc.size,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`,
    });
  }

  async remove(actor: AuthUser, id: string) {
    const doc = await this.prisma.issuedDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    await this.prisma.issuedDocument.delete({ where: { id } });
    await this.storage.remove(doc.storageKey);
    await this.audit.log({ actor, action: 'ISSUED_DOCUMENT_DELETED', entity: 'IssuedDocument', entityId: id, metadata: { clientId: doc.clientId, title: doc.title } });
    return { ok: true };
  }
}
