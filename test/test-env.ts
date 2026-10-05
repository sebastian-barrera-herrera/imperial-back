import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/imperial_test?schema=public';

// Los tests vacían las tablas: nunca deben apuntar a una base que no sea de pruebas.
if (!/\/[^/?]*test[^/?]*(\?|$)/i.test(TEST_DATABASE_URL)) {
  throw new Error(`TEST_DATABASE_URL debe apuntar a una base cuyo nombre contenga "test": ${TEST_DATABASE_URL}`);
}

export const TEST_STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), 'imperial-test-')), 'storage');
