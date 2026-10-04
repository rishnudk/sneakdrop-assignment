import { Router, Request, Response, NextFunction } from 'express';
import { buy } from '../services/hold.service.js';
import { joinWaitlist, leaveWaitlist, getWaitlistPosition } from '../services/waitlist.service.js';
import { startPayment } from '../services/payment.service.js';
import { getDropStatus, getInvariants } from '../services/status.service.js';
import { fakeAuth } from '../middleware/fakeAuth.js';
import { DEFAULT_PRODUCT_ID } from '../../prisma/seed.js';
import { prisma } from '../db.js';

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

/**
 * POST /api/waitlist/join
 * Joins the waiting queue when stock is 0.
 */
dropRouter.post('/waitlist/join', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = req.body?.productId || DEFAULT_PRODUCT_ID;
    const result = await joinWaitlist(req.user!.id, productId);

    res.status(201).json({
      message: 'Joined waiting line successfully',
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/waitlist/leave
 * Leaves the waiting queue voluntarily.
 */
dropRouter.post('/waitlist/leave', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = req.body?.productId || DEFAULT_PRODUCT_ID;
    const result = await leaveWaitlist(req.user!.id, productId);

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/waitlist/status
 * Retrieves current user position in line.
 */
dropRouter.get('/waitlist/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = (req.query.productId as string) || DEFAULT_PRODUCT_ID;
    const position = await getWaitlistPosition(prisma, req.user!.id, productId);

    res.status(200).json({
      inQueue: position !== null,
      waitlist: position,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/holds/:id/pay
 * Starts payment for an active hold.
 */
dropRouter.post('/holds/:id/pay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const holdId = req.params.id;
    const chaosOverrides = req.body?.chaos;
    const payment = await startPayment(req.user!.id, holdId, chaosOverrides);

    res.status(202).json({
      message: 'Payment initiated; awaiting gateway confirmation',
      ...payment,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/status
 * Read model for the drop page (pairs left, countdown, and place in waiting line).
 */
dropRouter.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = (req.query.productId as string) || DEFAULT_PRODUCT_ID;
    const status = await getDropStatus(req.user!.id, productId);
    res.status(200).json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/invariants
 * Developer/evaluator endpoint verifying the conservation invariant.
 */
dropRouter.get('/admin/invariants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = (req.query.productId as string) || DEFAULT_PRODUCT_ID;
    const invariants = await getInvariants(productId);
    res.status(200).json(invariants);
  } catch (err) {
    next(err);
  }
});
