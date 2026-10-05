import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';

type Ctx = { ip?: string; userAgent?: string };
const storage = new AsyncLocalStorage<Ctx>();

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  storage.run({ ip: req.ip, userAgent: req.headers['user-agent'] }, next);
}

export const getRequestContext = (): Ctx => storage.getStore() ?? {};
