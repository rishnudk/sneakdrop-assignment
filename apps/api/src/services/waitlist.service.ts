import { prisma, Tx } from '../db.js';
import { lockInventory } from '../lib/locks.js';
import { sweepExpired } from './hold.service.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';

export interface WaitlistPosition {
  position: number;
  ahead: number;
  size: number;
}

/**
 * Checks if a user is currently waiting in line and calculates their FIFO position.
 */
export async function getWaitlistPosition(
  client: Tx | typeof prisma,
  userId: string,
  productId: string
): Promise<WaitlistPosition | null> {
  const entry = await client.waitlistEntry.findFirst({
    where: { userId, productId, status: 'WAITING' },
    select: { seq: true },
  });

  if (!entry) return null;

  const ahead = await client.waitlistEntry.count({
    where: {
      productId,
      status: 'WAITING',
      seq: { lt: entry.seq },
    },
  });

  const size = await client.waitlistEntry.count({
    where: { productId, status: 'WAITING' },
  });

  return {
    position: ahead + 1,
    ahead,
    size,
  };
}

/**
 * Atomically joins the waiting line for a product when available stock is 0.
 */
export async function joinWaitlist(userId: string, productId: string) {
  return prisma.$transaction(async (tx) => {
    // 1. Lock the inventory row first to serialize with buys and sweeps
    await lockInventory(tx, productId);
    await sweepExpired(tx, productId);

    // 2. Joining is strictly allowed ONLY when available stock is 0
    const inv = await tx.inventory.findUniqueOrThrow({
      where: { productId },
    });

    if (inv.available > 0) {
      throw new AppError(
        409,
        'STOCK_AVAILABLE',
        'Stock is currently available for direct purchase. Please click Buy.'
      );
    }

    // 3. User quota validation
    const [counts] = await tx.$queryRaw<{ active: number; paid: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'HELD')::int AS active,
             count(*) FILTER (WHERE status = 'PAID')::int AS paid
      FROM "Hold"
      WHERE "userId" = ${userId} AND "productId" = ${productId}
    `;

    if (counts.active > 0) {
      throw new AppError(
        409,
        'ALREADY_HOLDING',
        'You already hold a pair. Complete payment or wait for your hold to expire.'
      );
    }

    if (counts.paid >= config.PURCHASE_LIMIT) {
      throw new AppError(
        409,
        'PURCHASE_LIMIT',
        `You have already purchased the maximum of ${config.PURCHASE_LIMIT} pairs.`
      );
    }

    // 4. Duplicate waitlist check
    const existing = await tx.waitlistEntry.findFirst({
      where: { userId, productId, status: 'WAITING' },
    });

    if (existing) {
      throw new AppError(409, 'ALREADY_WAITING', 'You are already in the waiting line.');
    }

    // 5. Enqueue user with strict sequence order
    const entry = await tx.waitlistEntry.create({
      data: {
        userId,
        productId,
        status: 'WAITING',
      },
    });

    const positionInfo = await getWaitlistPosition(tx, userId, productId);

    return {
      entryId: entry.id,
      ...positionInfo,
    };
  });
}

/**
 * Leaves the waiting line voluntarily.
 */
export async function leaveWaitlist(userId: string, productId: string) {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.waitlistEntry.findFirst({
      where: { userId, productId, status: 'WAITING' },
    });

    if (!entry) {
      return { success: true, message: 'Not currently in waiting line' };
    }

    await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: 'LEFT' },
    });

    return { success: true, message: 'Successfully left the waiting line' };
  });
}
