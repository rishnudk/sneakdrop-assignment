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

/**
 * POST /api/admin/simulate-rush
 * Simulates concurrent buyers hitting the buy endpoint at the exact same millisecond.
 */
dropRouter.post('/admin/simulate-rush', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = Math.min(Number(req.body?.count) || 30, 100);
    const productId = req.body?.productId || DEFAULT_PRODUCT_ID;
    const autoWaitlist = Boolean(req.body?.autoWaitlist ?? true);

    const startTime = performance.now();

    // 1. Ensure all simulated users exist
    const usernames = Array.from({ length: count }, (_, i) => `rush-shopper-${i + 1}`);
    const userRecords = await Promise.all(
      usernames.map(async (uname) => {
        return prisma.user.upsert({
          where: { username: uname },
          update: {},
          create: { username: uname },
        });
      })
    );

    // 2. Fire simultaneous buy requests at the exact same millisecond
    const buyPromises = userRecords.map(async (u) => {
      try {
        const hold = await buy(u.id, productId);
        return { username: u.username, userId: u.id, status: 'HELD', holdId: hold.id };
      } catch (err: any) {
        return { username: u.username, userId: u.id, status: err.code || 'ERROR', message: err.message };
      }
    });

    const results = await Promise.all(buyPromises);
    const held = results.filter((r) => r.status === 'HELD');
    const soldOut = results.filter((r) => r.status === 'SOLD_OUT');

    // 3. Have sold-out users join the waiting line automatically
    let waitlistedCount = 0;
    if (autoWaitlist && soldOut.length > 0) {
      await Promise.all(
        soldOut.map(async (so) => {
          try {
            await joinWaitlist(so.userId, productId);
            waitlistedCount++;
          } catch {
            // ignore if already in queue
          }
        })
      );
    }

    const durationMs = Math.round(performance.now() - startTime);

    res.status(200).json({
      message: `Simulated ${count} concurrent buyers`,
      attempted: count,
      held: held.length,
      soldOut: soldOut.length,
      waitlisted: waitlistedCount,
      durationMs,
      results,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/reset
 * Resets the drop back to initial state (20 available, no holds, no waitlist).
 */
dropRouter.post('/admin/reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = req.body?.productId || DEFAULT_PRODUCT_ID;

    await prisma.webhookEvent.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.hold.deleteMany();
    await prisma.waitlistEntry.deleteMany();

    await prisma.inventory.upsert({
      where: { productId },
      update: { total: 20, available: 20 },
      create: { productId, total: 20, available: 20 },
    });

    res.status(200).json({
      message: 'Drop reset successfully to 20 available pairs.',
      available: 20,
      total: 20,
    });
  } catch (err) {
    next(err);
  }
});

