import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, Profile, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto';

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /** Vista del perfil con datos sensibles descifrados; el número de cuenta solo se expone enmascarado. */
  present(user: Pick<User, 'id' | 'email' | 'fullName'>, profile: Profile | null) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      cedula: profile?.cedulaEnc ? this.crypto.decrypt(profile.cedulaEnc) : null,
      phone: profile?.phone ?? null,
      address: profile?.address ?? null,
      city: profile?.city ?? null,
      bankName: profile?.bankName ?? null,
      accountType: profile?.accountType ?? null,
      accountNumberMasked: profile?.accountLast4 ? `••••${profile.accountLast4}` : null,
      hasBankAccount: Boolean(profile?.accountNumberEnc),
      updatedAt: profile?.updatedAt ?? null,
    };
  }

  async get(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
    return this.present(user, user.profile);
  }

  async update(actor: AuthUser, dto: UpdateProfileDto) {
    const data: Prisma.ProfileUpdateInput = {};
    if (dto.cedula !== undefined) {
      data.cedulaEnc = dto.cedula ? this.crypto.encrypt(dto.cedula) : null;
      data.cedulaHash = dto.cedula ? this.crypto.blindIndex(dto.cedula) : null;
    }
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.bankName !== undefined) data.bankName = dto.bankName;
    if (dto.accountType !== undefined) data.accountType = dto.accountType;
    if (dto.accountNumber) {
      const digits = dto.accountNumber.replace(/\D/g, '');
      data.accountNumberEnc = this.crypto.encrypt(dto.accountNumber);
      data.accountLast4 = digits.slice(-4);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (dto.fullName) await tx.user.update({ where: { id: actor.id }, data: { fullName: dto.fullName } });
        await tx.profile.upsert({ where: { userId: actor.id }, create: { ...(data as Prisma.ProfileUncheckedCreateInput), userId: actor.id }, update: data });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Esa cédula ya está registrada en otra cuenta');
      }
      throw e;
    }
    await this.audit.log({
      actor,
      action: 'PROFILE_UPDATED',
      entity: 'Profile',
      entityId: actor.id,
      // Solo se registran los nombres de los campos, nunca los valores sensibles.
      metadata: { fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined) },
    });
    return this.get(actor.id);
  }
}
