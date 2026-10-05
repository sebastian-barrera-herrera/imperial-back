const PLACEHOLDER_MARKER = 'change-me';

export type AppEnv = {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  DATA_ENCRYPTION_KEY: string;
  CORS_ORIGIN: string;
  COOKIE_SECURE: boolean;
  STORAGE_DIR: string;
  DEFAULT_CURRENCY: string;
};

export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY debe ser de 32 bytes (64 caracteres hex o base64).');
  }
  return key;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const str = (key: string): string => {
    const value = config[key];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${key} es obligatorio`);
      return '';
    }
    return value;
  };

  const nodeEnv = (config.NODE_ENV as string) || 'development';
  const databaseUrl = str('DATABASE_URL');
  const jwtSecret = str('JWT_SECRET');
  const dataKey = str('DATA_ENCRYPTION_KEY');

  if (jwtSecret && jwtSecret.length < 32) errors.push('JWT_SECRET debe tener al menos 32 caracteres');
  if (dataKey) {
    try {
      parseEncryptionKey(dataKey);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (nodeEnv === 'production') {
    if (jwtSecret.includes(PLACEHOLDER_MARKER) || dataKey.includes(PLACEHOLDER_MARKER)) {
      errors.push('JWT_SECRET / DATA_ENCRYPTION_KEY siguen con el valor de ejemplo; genera valores reales');
    }
    if (!config.CORS_ORIGIN) errors.push('CORS_ORIGIN es obligatorio en producción');
  }
  if (errors.length) {
    throw new Error(`Configuración inválida:\n - ${errors.join('\n - ')}`);
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    PORT: Number(config.PORT ?? 4000),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    DATA_ENCRYPTION_KEY: dataKey,
    CORS_ORIGIN: (config.CORS_ORIGIN as string) ?? 'http://localhost:3000',
    COOKIE_SECURE: config.COOKIE_SECURE !== undefined ? String(config.COOKIE_SECURE) === 'true' : nodeEnv === 'production',
    STORAGE_DIR: (config.STORAGE_DIR as string) ?? 'storage',
    DEFAULT_CURRENCY: (config.DEFAULT_CURRENCY as string) ?? 'USD',
  };
}
