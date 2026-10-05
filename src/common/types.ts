import { Role } from '@prisma/client';

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const STAFF_ROLES: Role[] = [Role.SUPERADMIN, Role.LAWYER];
export const isStaff = (user: { role: Role }) => STAFF_ROLES.includes(user.role);
