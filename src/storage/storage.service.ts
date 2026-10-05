import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createReadStream, ReadStream } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import * as path from 'path';

/** Almacenamiento en disco local. Para producción multi-instancia, reemplazar por S3/GCS con la misma interfaz. */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = path.resolve(config.get<string>('STORAGE_DIR') ?? 'storage');
  }

  async save(ownerId: string, buffer: Buffer, extension: string): Promise<string> {
    const key = `${ownerId}/${randomUUID()}${extension}`;
    const absolute = this.resolve(key);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer, { mode: 0o600 });
    return key;
  }

  stream(key: string): ReadStream {
    return createReadStream(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  private resolve(key: string): string {
    const absolute = path.resolve(this.root, key);
    if (!absolute.startsWith(this.root + path.sep)) throw new Error('Clave de almacenamiento inválida');
    return absolute;
  }
}
