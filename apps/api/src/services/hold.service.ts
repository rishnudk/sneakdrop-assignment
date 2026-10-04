import { prisma, Tx } from '../db.js';
import { lockInventory } from '../lib/locks.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';

/**
 * Verifies if a user is still eligible to receive a pair (no active holds, paid < limit).
 */
async function isEligible(tx: Tx, userId: string, productId: string): Promise<boolean> {
  const [counts] = await tx.$queryRaw<{ active: number; paid: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'HELD')::int AS active,
           count(*) FILTER (WHERE status = 'PAID')::int AS paid
    FROM "Hold"
    WHERE "userId" = ${userId} AND "productId" = ${productId}
  `;
  return counts.active === 0 && counts.paid < config.PURCHASE_LIMIT;
}

/**
 * Releases a single expired/freed inventory unit.
 * Implements DIRECT HAND-OFF:
 * - If someone is in the waiting line, promotes them directly into an active hold with fresh 5-minute countdown.
 * - Only if the queue is empty does the unit return to public available stock.
 * This guarantees outside buyers cannot jump ahead of queued users.
 */
export async function releaseUnit(tx: Tx, productId: string) {
  while (true) {
    const [next] = await tx.$queryRaw<{ id: string; userId: string }[]>`
      SELECT id, "userId"
      FROM "WaitlistEntry"
      WHERE "productId" = ${productId} AND status = 'WAITING'
      ORDER BY seq ASC
      LIMIT 1
      FOR UPDATE
    `;

    if (!next) {
      // Nobody waiting: return pair directly back to available inventory
      await tx.$executeRaw`
        UPDATE "Inventory"
        SET available = available + 1
        WHERE "productId" = ${productId}
      `;
      return;
    }

    if (!(await isEligible(tx, next.userId, productId))) {
      // User is no longer eligible, mark LEFT and try the next person in line
      await tx.waitlistEntry.update({
        where: { id: next.id },
        data: { status: 'LEFT' },
      });
      continue;
    }

    // Direct hand-off: mark waitlist entry as PROMOTED
    await tx.waitlistEntry.update({
      where: { id: next.id },
      data: { status: 'PROMOTED' },
    });

    // Create a new 5-minute hold directly for this promoted user
    await tx.$executeRaw`
      INSERT INTO "Hold" (id, "userId", "productId", status, source, "expiresAt")
      VALUES (
        gen_random_uuid(),
        ${next.userId},
        ${productId},
        'HELD',
        'WAITLIST',
        now() + (${config.HOLD_TTL_SECONDS} * interval '1 second')
      )
    `;

    return; // Direct hand-off complete
  }
}

/**
 * Sweeps all expired holds (expiresAt <= now()) and releases each unit.
 * Must be executed within a transaction holding the inventory row lock.
 */
export async function sweepExpired(tx: Tx, productId: string) {
  const expired = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "Hold"
    SET status = 'EXPIRED'
    WHERE "productId" = ${productId}
      AND status = 'HELD'
      AND "expiresAt" <= now()
    RETURNING id
  `;

  for (let i = 0; i < expired.length; i++) {
    await releaseUnit(tx, productId);
  }

  return expired;
}

/**
 * Atomically attempts to purchase/reserve a hold on a product.
 * Enforces:
 *  - Global stock conservation with zero race conditions
 *  - Max 1 active hold per user
 *  - Max 2 lifetime purchases per user
 *  - Queue priority (cannot jump queue if already waiting)
 */
export async function buy(userId: string, productId: string) {
  // Fast-path read: if stock is already 0 and no holds are expired, reject immediately
  // to avoid exhausting connection pools under massive stampedes
  const fastInv = await prisma.inventory.findUnique({
    where: { productId },
    select: { available: true },
  });

  if (fastInv && fastInv.available === 0) {
    const expiredCount = await prisma.hold.count({
      where: { productId, status: 'HELD', expiresAt: { lte: new Date() } },
    });
    if (expiredCount === 0) {
      throw new AppError(409, 'SOLD_OUT', 'All pairs are currently held or sold.');
    }
  }

  return prisma.$transaction(
    async (tx) => {
      // 1. Lock the inventory row first (standard lock order prevents deadlock)
      await lockInventory(tx, productId);

      // 2. Perform lazy sweep of any expired holds
      await sweepExpired(tx, productId);

    // 3. User quota validation
    const [counts] = await tx.$queryRaw<{ active: number; paid: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'HELD')::int AS active,
             count(*) FILTER (WHERE status = 'PAID')::int AS paid
      FROM "Hold"
      WHERE "userId" = ${userId} AND "productId" = ${productId}
    `;

    if (counts.active > 0) {
      throw new AppError(409, 'ALREADY_HOLDING', 'You already have an active hold on this sneaker.');
    }

    if (counts.paid >= config.PURCHASE_LIMIT) {
      throw new AppError(409, 'PURCHASE_LIMIT', `You have reached the limit of ${config.PURCHASE_LIMIT} pairs.`);
    }

    // 4. Queue priority: If user is waiting in line, they must wait for promotion
    const isWaiting = await tx.waitlistEntry.count({
      where: { userId, productId, status: 'WAITING' },
    });

    if (isWaiting > 0) {
      throw new AppError(409, 'QUEUE_EXISTS', 'You are currently in the waiting line. Please wait for your turn.');
    }

    // 5. Atomic stock decrement
    const dec = await tx.$queryRaw<{ available: number }[]>`
      UPDATE "Inventory"
      SET available = available - 1
      WHERE "productId" = ${productId} AND available > 0
      RETURNING available
    `;

    if (dec.length === 0) {
      throw new AppError(409, 'SOLD_OUT', 'All pairs are currently held or sold.');
    }

    // 6. Create the 5-minute hold using database clock
    const [hold] = await tx.$queryRaw<
      {
        id: string;
        userId: string;
        productId: string;
        status: string;
        source: string;
        expiresAt: Date;
        createdAt: Date;
      }[]
    >`
      INSERT INTO "Hold" (id, "userId", "productId", status, source, "expiresAt")
      VALUES (
        gen_random_uuid(),
        ${userId},
        ${productId},
        'HELD',
        'DIRECT',
        now() + (${config.HOLD_TTL_SECONDS} * interval '1 second')
      )
      RETURNING *
    `;

    return hold;
  },
  { maxWait: 15000, timeout: 20000 }
  );
}
