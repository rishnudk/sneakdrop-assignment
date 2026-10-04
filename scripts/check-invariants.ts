import { prisma } from '../apps/api/src/db.js';
import { DEFAULT_PRODUCT_ID } from '../apps/api/prisma/seed.js';

export async function runInvariantCheck(productId: string = DEFAULT_PRODUCT_ID) {
  console.log('\n=============================================================');
  console.log('       🔍 SNEAKER DROP INVARIANT CONSERVATION AUDIT          ');
  console.log('=============================================================');

  const now = new Date();

  const inventory = await prisma.inventory.findUniqueOrThrow({
    where: { productId },
    include: { product: true },
  });

  const [audit] = await prisma.$queryRaw<
    {
      held: number;
      paid: number;
      expired: number;
      cancelled: number;
      waitlist_waiting: number;
      waitlist_promoted: number;
      waitlist_left: number;
      users_with_multiple_holds: number;
      users_over_limit: number;
    }[]
  >`
    SELECT 
      (SELECT count(*)::int FROM "Hold" WHERE "productId" = ${productId} AND status = 'HELD' AND "expiresAt" > ${now}) AS held,
      (SELECT count(*)::int FROM "Hold" WHERE "productId" = ${productId} AND status = 'PAID') AS paid,
      (SELECT count(*)::int FROM "Hold" WHERE "productId" = ${productId} AND (status = 'EXPIRED' OR (status = 'HELD' AND "expiresAt" <= ${now}))) AS expired,
      (SELECT count(*)::int FROM "Hold" WHERE "productId" = ${productId} AND status = 'CANCELLED') AS cancelled,
      (SELECT count(*)::int FROM "WaitlistEntry" WHERE "productId" = ${productId} AND status = 'WAITING') AS waitlist_waiting,
      (SELECT count(*)::int FROM "WaitlistEntry" WHERE "productId" = ${productId} AND status = 'PROMOTED') AS waitlist_promoted,
      (SELECT count(*)::int FROM "WaitlistEntry" WHERE "productId" = ${productId} AND status = 'LEFT') AS waitlist_left,
      (SELECT count(*)::int FROM (
        SELECT "userId" FROM "Hold"
        WHERE "productId" = ${productId} AND status = 'HELD' AND "expiresAt" > ${now}
        GROUP BY "userId" HAVING count(*) > 1
      ) x) AS users_with_multiple_holds,
      (SELECT count(*)::int FROM (
        SELECT "userId" FROM "Hold"
        WHERE "productId" = ${productId} AND status = 'PAID'
        GROUP BY "userId" HAVING count(*) > 2
      ) y) AS users_over_limit
  `;

  const total = inventory.total;
  const available = inventory.available;
  const held = audit.held;
  const paid = audit.paid;
  const sum = available + held + paid;

  console.log(`Product:                 ${inventory.product.name}`);
  console.log(`Total Inventory:         ${total}`);
  console.log('-------------------------------------------------------------');
  console.log(`Stock Available:         ${available}`);
  console.log(`Actively Held (5m):      ${held}`);
  console.log(`Finalized Sales (Paid):  ${paid}`);
  console.log('-------------------------------------------------------------');
  console.log(`Conservation Sum:        ${available} (avail) + ${held} (held) + ${paid} (paid) = ${sum}`);
  console.log(`Expired Holds Reclaimed: ${audit.expired}`);
  console.log(`Cancelled Holds:         ${audit.cancelled}`);
  console.log('-------------------------------------------------------------');
  console.log(`Waitlist Waiting:        ${audit.waitlist_waiting}`);
  console.log(`Waitlist Promoted:       ${audit.waitlist_promoted}`);
  console.log(`Waitlist Left:           ${audit.waitlist_left}`);
  console.log('-------------------------------------------------------------');
  console.log(`Users with > 1 Hold:     ${audit.users_with_multiple_holds} (Must be 0)`);
  console.log(`Users over limit (> 2):  ${audit.users_over_limit} (Must be 0)`);
  console.log('=============================================================');

  const isConservationValid = sum === total;
  const isNoMultipleHolds = audit.users_with_multiple_holds === 0;
  const isNoOverLimit = audit.users_over_limit === 0;
  const isAllValid = isConservationValid && isNoMultipleHolds && isNoOverLimit;

  if (isAllValid) {
    console.log('✅ ALL INVARIANTS SATISFIED. ZERO OVERSELLING CONFIRMED.\n');
    return true;
  } else {
    console.error('❌ INVARIANT VIOLATION DETECTED!\n');
    return false;
  }
}

// Direct execution from CLI
if (process.argv[1]?.includes('check-invariants')) {
  runInvariantCheck()
    .then((ok) => {
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('Failed to run invariant check:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
