import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../apps/api/src/db.js';
import { app } from '../apps/api/src/app.js';
import { DEFAULT_PRODUCT_ID } from '../apps/api/prisma/seed.js';
import { Server } from 'http';

describe('Step 3: Concurrency & Zero-Oversell Test', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // 1. Reset database state before test
    await prisma.payment.deleteMany();
    await prisma.hold.deleteMany();
    await prisma.waitlistEntry.deleteMany();
    await prisma.user.deleteMany();

    await prisma.inventory.upsert({
      where: { productId: DEFAULT_PRODUCT_ID },
      update: { total: 20, available: 20 },
      create: { productId: DEFAULT_PRODUCT_ID, total: 20, available: 20 },
    });

    // 2. Start test server on random ephemeral port
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://localhost:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  it('handles 100 simultaneous Buy clicks: exactly 20 succeed and 80 receive SOLD_OUT', async () => {
    const totalUsers = 100;
    const userIds = Array.from({ length: totalUsers }, (_, i) => `concurrent-shopper-${i}`);

    console.log(`Firing ${totalUsers} simultaneous requests at the exact same millisecond...`);

    // Fire all 100 requests in parallel
    const responses = await Promise.all(
      userIds.map(async (userId) => {
        const res = await fetch(`${baseUrl}/api/buy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': userId,
          },
          body: JSON.stringify({ productId: DEFAULT_PRODUCT_ID }),
        });

        const data = await res.json();
        return {
          status: res.status,
          data,
          userId,
        };
      })
    );

    // 1. Count HTTP outcomes
    const successful = responses.filter((r) => r.status === 201);
    const soldOut = responses.filter((r) => r.status === 409 && r.data.error === 'SOLD_OUT');

    console.log(`Results: ${successful.length} created (201), ${soldOut.length} sold out (409)`);

    expect(successful.length).toBe(20);
    expect(soldOut.length).toBe(80);
    expect(successful.length + soldOut.length).toBe(totalUsers);

    // 2. Check Database Invariants
    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId: DEFAULT_PRODUCT_ID },
    });

    const activeHolds = await prisma.hold.count({
      where: { productId: DEFAULT_PRODUCT_ID, status: 'HELD' },
    });

    const paidHolds = await prisma.hold.count({
      where: { productId: DEFAULT_PRODUCT_ID, status: 'PAID' },
    });

    console.log('Database verification:', {
      total: inventory.total,
      available: inventory.available,
      activeHolds,
      paidHolds,
    });

    // Stock must be exactly 0, never negative
    expect(inventory.available).toBe(0);
    expect(activeHolds).toBe(20);

    // Invariant: available + count(HELD) + count(PAID) === total
    expect(inventory.available + activeHolds + paidHolds).toBe(inventory.total);
  });
});
