import { Injectable } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsHub } from './notifications.hub';

export type NotifyInput = {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
};

const PREFERENCE_BY_TYPE: Partial<Record<NotificationType, 'documents' | 'disbursements' | 'cases' | 'opportunities'>> = {
  DOCUMENT: 'documents',
  DISBURSEMENT: 'disbursements',
  CASE: 'cases',
  OPPORTUNITY: 'opportunities',
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: NotificationsHub,
  ) {}

  /** Crea la alerta respetando las preferencias del usuario (las de tipo SYSTEM siempre se entregan). */
  async notify(userId: string, input: NotifyInput) {
    const prefKey = PREFERENCE_BY_TYPE[input.type];
    if (prefKey) {
      const pref = await this.prisma.notificationPreference.findUnique({ where: { userId } });
      if (pref && pref[prefKey] === false) return null;
    }
    const notification = await this.prisma.notification.create({ data: { userId, ...input } });
    this.hub.emit(userId, { type: 'notification', data: notification });
    return notification;
  }

  async notifyMany(userIds: string[], input: NotifyInput) {
    if (!userIds.length) return 0;
    const prefKey = PREFERENCE_BY_TYPE[input.type];
    let targets = userIds;
    if (prefKey) {
      const muted = await this.prisma.notificationPreference.findMany({
        where: { userId: { in: userIds }, [prefKey]: false } as Prisma.NotificationPreferenceWhereInput,
        select: { userId: true },
      });
      const mutedIds = new Set(muted.map((m) => m.userId));
      targets = userIds.filter((id) => !mutedIds.has(id));
    }
    if (!targets.length) return 0;
    // createManyAndReturn devuelve las filas creadas: cada usuario conectado recibe su notificación completa en tiempo real.
    const rows = await this.prisma.notification.createManyAndReturn({ data: targets.map((userId) => ({ userId, ...input })) });
    for (const row of rows) this.hub.emit(row.userId, { type: 'notification', data: row });
    return rows.length;
  }
}
