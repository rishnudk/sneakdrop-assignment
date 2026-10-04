import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../apps/api/src/db.js';
import { app } from '../apps/api/src/app.js';
import { DEFAULT_PRODUCT_ID } from '../apps/api/prisma/seed.js';
import { Server } from 'http';

describe('Step 4: User Purchase & Hold Limits (Rule 2)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
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

  beforeEach(async () => {
    // Reset database state before each test
    await prisma.payment.deleteMany();
    await prisma.hold.deleteMany();
    await prisma.waitlistEntry.deleteMany();
    await prisma.user.deleteMany();

    await prisma.inventory.upsert({
      where: { productId: DEFAULT_PRODUCT_ID },
      update: { total: 20, available: 20 },
      create: { productId: DEFAULT_PRODUCT_ID, total: 20, available: 20 },
    });
  });

  it('enforces max 1 active hold under rapid parallel double-clicks from the same user', async () => {
    const userId = 'fast-clicker-sam';
    const clickCount = 20;

    // Fire 20 parallel buy requests from the same user
    const responses = await Promise.all(
      Array.from({ length: clickCount }, async () => {
        const res = await fetch(`${baseUrl}/api/buy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': userId,
          },
          body: JSON.stringify({ productId: DEFAULT_PRODUCT_ID }),
        });

        const data = await res.json();
        return { status: res.status, data };
      })
    );

    const successful = responses.filter((r) => r.status === 201);
    const rejectedHolding = responses.filter(
      (r) => r.status === 409 && r.data.error === 'ALREADY_HOLDING'
    );

    // Exactly 1 hold created, 19 rejected
    expect(successful.length).toBe(1);
    expect(rejectedHolding.length).toBe(clickCount - 1);

    // Database verification: exactly 1 active hold for this user
    const userHolds = await prisma.hold.findMany({
      where: {
        product: { id: DEFAULT_PRODUCT_ID },
        user: { username: userId },
      },
    });

    expect(userHolds.length).toBe(1);
    expect(userHolds[0].status).toBe('HELD');

    // Available inventory should have decremented by exactly 1
    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId: DEFAULT_PRODUCT_ID },
    });
    expect(inventory.available).toBe(19);
  });

  it('enforces max 2 lifetime purchases per user', async () => {
    const userId = 'sneakerhead-alex';

    // 1. Alex buys pair #1
    const buy1 = await fetch(`${baseUrl}/api/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    });
    expect(buy1.status).toBe(201);
    const hold1Data = await buy1.json();
    const hold1Id = hold1Data.hold.id;

    // Try buying again while holding pair #1 -> Should be blocked
    const buyDuplicateHold = await fetch(`${baseUrl}/api/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    });
    expect(buyDuplicateHold.status).toBe(409);
    expect((await buyDuplicateHold.json()).error).toBe('ALREADY_HOLDING');

    // Simulate payment completion for pair #1
    await prisma.hold.update({
      where: { id: hold1Id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    // 2. Alex buys pair #2 -> Should succeed (has 1 paid, 0 active holds)
    const buy2 = await fetch(`${baseUrl}/api/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    });
    expect(buy2.status).toBe(201);
    const hold2Data = await buy2.json();
    const hold2Id = hold2Data.hold.id;

    // Simulate payment completion for pair #2
    await prisma.hold.update({
      where: { id: hold2Id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    // 3. Alex attempts to buy pair #3 -> Must be rejected with PURCHASE_LIMIT
    const buy3 = await fetch(`${baseUrl}/api/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    });
    expect(buy3.status).toBe(409);
    const buy3Data = await buy3.json();
    expect(buy3Data.error).toBe('PURCHASE_LIMIT');

    // 4. Verify in DB: exactly 2 paid holds, 0 active holds
    const userPaidHolds = await prisma.hold.count({
      where: {
        product: { id: DEFAULT_PRODUCT_ID },
        user: { username: userId },
        status: 'PAID',
      },
    });
    expect(userPaidHolds).toBe(2);

    const userActiveHolds = await prisma.hold.count({
      where: {
        product: { id: DEFAULT_PRODUCT_ID },
        user: { username: userId },
        status: 'HELD',
      },
    });
    expect(userActiveHolds).toBe(0);

    // Available inventory should have decremented by 2
    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId: DEFAULT_PRODUCT_ID },
    });
    expect(inventory.available).toBe(18);
  });
});
