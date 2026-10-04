import { prisma, Tx } from '../db.js';
import { lockInventory } from '../lib/locks.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';

/**
 * Checks and marks any holds whose expiresAt <= now() as EXPIRED.
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

  // For any expired hold without an active waitlist, available units are restored
  if (expired.length > 0) {
    // Check if there are users waiting in the queue
    const waitingCount = await tx.waitlistEntry.count({
      where: { productId, status: 'WAITING' },
    });

    if (waitingCount === 0) {
      await tx.$executeRaw`
        UPDATE "Inventory"
        SET available = available + ${expired.length}
        WHERE "productId" = ${productId}
      `;
    }
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
  return prisma.$transaction(async (tx) => {
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
  });
}
