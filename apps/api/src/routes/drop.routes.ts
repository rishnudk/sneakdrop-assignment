import { Router, Request, Response, NextFunction } from 'express';
import { buy } from '../services/hold.service.js';
import { fakeAuth } from '../middleware/fakeAuth.js';
import { DEFAULT_PRODUCT_ID } from '../../prisma/seed.js';

export const dropRouter = Router();

// Apply fake authentication to all drop routes
dropRouter.use(fakeAuth);

/**
 * POST /api/buy
 * Attempts to acquire an atomic 5-minute hold on a sneaker.
 */
dropRouter.post('/buy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = req.body?.productId || DEFAULT_PRODUCT_ID;
    const hold = await buy(req.user!.id, productId);

    res.status(201).json({
      message: 'Hold acquired successfully',
      hold,
    });
  } catch (err) {
    next(err);
  }
});
