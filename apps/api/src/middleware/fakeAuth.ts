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

    // Fast path: find existing user
    let user = await prisma.user.findUnique({
      where: { username: rawUserId },
    });

    if (!user) {
      try {
        user = await prisma.user.create({
          data: { username: rawUserId },
        });
      } catch (err: any) {
        // If another parallel request created the user concurrently, recover cleanly
        if (err.code === 'P2002') {
          user = await prisma.user.findUniqueOrThrow({
            where: { username: rawUserId },
          });
        } else {
          throw err;
        }
      }
    }

    req.user = {
      id: user.id,
      username: user.username,
    };

    next();
  } catch (err) {
    next(err);
  }
}
