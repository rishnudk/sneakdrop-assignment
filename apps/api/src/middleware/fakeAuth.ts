import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../lib/errors.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
      };
    }
  }
}

export async function fakeAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const rawUserId = (req.headers['x-user-id'] as string)?.trim();

    if (!rawUserId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing required x-user-id header');
    }

    // Upsert user based on username/id so DB foreign keys remain valid
    const user = await prisma.user.upsert({
      where: { username: rawUserId },
      update: {},
      create: { username: rawUserId },
    });

    req.user = {
      id: user.id,
      username: user.username,
    };

    next();
  } catch (err) {
    next(err);
  }
}
