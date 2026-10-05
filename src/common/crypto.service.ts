import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { parseEncryptionKey } from '../config/env';

/** Cifrado AES-256-GCM para datos sensibles (cédula, cuenta bancaria) y índice ciego para búsquedas/unicidad. */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly indexKey: Buffer;

  constructor(config: ConfigService) {
    this.key = parseEncryptionKey(config.getOrThrow<string>('DATA_ENCRYPTION_KEY'));
    this.indexKey = createHmac('sha256', this.key).update('imperial:blind-index').digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Formato de dato cifrado inválido');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  blindIndex(value: string): string {
    return createHmac('sha256', this.indexKey).update(value.trim().toLowerCase()).digest('hex');
  }
}
