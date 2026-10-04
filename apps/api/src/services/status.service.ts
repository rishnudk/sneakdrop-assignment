import { prisma } from '../db.js';
import { DEFAULT_PRODUCT_ID } from '../../prisma/seed.js';
import { getWaitlistPosition } from './waitlist.service.js';

export async function getDropStatus(userId: string, productId: string = DEFAULT_PRODUCT_ID) {
  const now = new Date();

  // 1. Fetch inventory stock
  const inventory = await prisma.inventory.findUniqueOrThrow({
    where: { productId },
  });

  // 2. Fetch current counts
  // Only holds whose expiresAt > now() are actively held
  const activeHoldsCount = await prisma.hold.count({
    where: {
      productId,
      status: 'HELD',
      expiresAt: { gt: now },
    },
  });

  const paidHoldsCount = await prisma.hold.count({
    where: {
      productId,
      status: 'PAID',
    },
  });

  // 3. User details: purchased count
  const userPaidCount = await prisma.hold.count({
    where: {
      productId,
      userId,
      status: 'PAID',
    },
  });

  // 4. User details: active hold
  const activeHold = await prisma.hold.findFirst({
    where: {
      productId,
      userId,
      status: 'HELD',
      expiresAt: { gt: now },
    },
    include: {
      payments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  // 5. User details: waitlist status
  const waitlistInfo = await getWaitlistPosition(prisma, userId, productId);

  const holdDetails = activeHold
    ? {
        id: activeHold.id,
        status: activeHold.status,
        source: activeHold.source,
        expiresAt: activeHold.expiresAt.toISOString(),
        secondsLeft: Math.max(0, Math.floor((activeHold.expiresAt.getTime() - now.getTime()) / 1000)),
        payment: activeHold.payments[0]
          ? {
              id: activeHold.payments[0].id,
              status: activeHold.payments[0].status,
              providerRef: activeHold.payments[0].providerRef,
              refundNeeded: activeHold.payments[0].refundNeeded,
            }
          : null,
      }
    : null;

  return {
    serverNow: now.toISOString(),
    stock: {
      total: inventory.total,
      available: inventory.available,
      held: activeHoldsCount,
      paid: paidHoldsCount,
    },
    me: {
      userId,
      purchased: userPaidCount,
      hold: holdDetails,
      waitlist: waitlistInfo,
    },
  };
}

/**
 * Checks system conservation invariants:
 * 1. available + held + paid === total (20)
 * 2. No user holds > 1 active shoe
 * 3. No user bought > 2 shoes
 */
export async function getInvariants(productId: string = DEFAULT_PRODUCT_ID) {
  const inv = await prisma.inventory.findUniqueOrThrow({
    where: { productId },
  });

  const [res] = await prisma.$queryRaw<
    {
      held: number;
      paid: number;
      users_with_multiple_holds: number;
      users_over_limit: number;
    }[]
  >`
    SELECT 
      (SELECT count(*)::int FROM "Hold" WHERE "productId" = ${productId} AND status = 'HELD' AND "expiresAt" > now()) AS held,
      (SELECT count(*)::int FROM "Hold" WHERE "productId" = ${productId} AND status = 'PAID') AS paid,
      (SELECT count(*)::int FROM (
        SELECT "userId" FROM "Hold"
        WHERE "productId" = ${productId} AND status = 'HELD' AND "expiresAt" > now()
        GROUP BY "userId" HAVING count(*) > 1
      ) x) AS users_with_multiple_holds,
      (SELECT count(*)::int FROM (
        SELECT "userId" FROM "Hold"
        WHERE "productId" = ${productId} AND status = 'PAID'
        GROUP BY "userId" HAVING count(*) > 2
      ) y) AS users_over_limit
  `;

  const invariantSum = inv.available + res.held + res.paid;
  const isConsistent =
    invariantSum === inv.total &&
    res.users_with_multiple_holds === 0 &&
    res.users_over_limit === 0;

  return {
    ok: isConsistent,
    total: inv.total,
    available: inv.available,
    held: res.held,
    paid: res.paid,
    sum: invariantSum,
    usersWithMultipleHolds: res.users_with_multiple_holds,
    usersOverLimit: res.users_over_limit,
  };
}
