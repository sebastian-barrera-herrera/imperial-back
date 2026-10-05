import { TEST_DATABASE_URL, TEST_STORAGE_DIR } from './test-env';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.DATA_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.CORS_ORIGIN = 'http://localhost:3000';
process.env.STORAGE_DIR = TEST_STORAGE_DIR;
process.env.COOKIE_SECURE = 'false';
