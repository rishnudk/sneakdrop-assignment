import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../apps/api/src/db.js';
import { app } from '../apps/api/src/app.js';
import { DEFAULT_PRODUCT_ID } from '../apps/api/prisma/seed.js';
import { sweepExpired } from '../apps/api/src/services/hold.service.js';
import { lockInventory } from '../apps/api/src/lib/locks.js';
import { Server } from 'http';

describe('Step 5: Hold Expiry, Direct Queue Hand-off & Waitlist (Rule 3)', () => {
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

  it('rejects waitlist join when stock is still available', async () => {
    const res = await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'eager-shopper' },
    });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('STOCK_AVAILABLE');
  });

  it('allows joining the waitlist in strict FIFO order when stock is 0', async () => {
    // 1. Exhaust stock to 0 by allocating 20 holds
    await prisma.inventory.update({
      where: { productId: DEFAULT_PRODUCT_ID },
      data: { available: 0 },
    });

    // 2. Users join the line in sequence
    const res1 = await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'waiter-alice' },
    });
    expect(res1.status).toBe(201);
    const data1 = await res1.json();
    expect(data1.position).toBe(1);
    expect(data1.ahead).toBe(0);

    const res2 = await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'waiter-bob' },
    });
    expect(res2.status).toBe(201);
    const data2 = await res2.json();
    expect(data2.position).toBe(2);
    expect(data2.ahead).toBe(1);

    const res3 = await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'waiter-charlie' },
    });
    expect(res3.status).toBe(201);
    const data3 = await res3.json();
    expect(data3.position).toBe(3);
    expect(data3.ahead).toBe(2);

    // Try joining again with same user -> blocked
    const resDuplicate = await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'waiter-alice' },
    });
    expect(resDuplicate.status).toBe(409);
    expect((await resDuplicate.json()).error).toBe('ALREADY_WAITING');
  });

  it('automatically promotes the first person in line when a hold expires (direct hand-off)', async () => {
    // 1. Create an active hold for holder-1 and mark available = 0
    const holder = await prisma.user.create({ data: { username: 'holder-1' } });
    const hold = await prisma.hold.create({
      data: {
        userId: holder.id,
        productId: DEFAULT_PRODUCT_ID,
        status: 'HELD',
        expiresAt: new Date(Date.now() + 300000), // Active 5m hold
      },
    });

    await prisma.inventory.update({
      where: { productId: DEFAULT_PRODUCT_ID },
      data: { available: 0 },
    });

    // 2. Queue up Alice and Bob while stock is 0 and hold is active
    const resAlice = await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'queue-alice' },
    });
    expect(resAlice.status).toBe(201);

    const resBob = await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'queue-bob' },
    });
    expect(resBob.status).toBe(201);

    // 3. Fast-forward: holder-1's hold expires
    await prisma.hold.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 10000) }, // Expired 10s ago
    });

    // 4. Trigger sweepExpired inside a transaction (like the background worker does)
    await prisma.$transaction(async (tx) => {
      await lockInventory(tx, DEFAULT_PRODUCT_ID);
      const swept = await sweepExpired(tx, DEFAULT_PRODUCT_ID);
      expect(swept.length).toBe(1);
    });

    // 4. Verify Alice was promoted directly
    const aliceUser = await prisma.user.findUniqueOrThrow({
      where: { username: 'queue-alice' },
    });

    const aliceHold = await prisma.hold.findFirst({
      where: {
        userId: aliceUser.id,
        productId: DEFAULT_PRODUCT_ID,
        status: 'HELD',
      },
    });

    expect(aliceHold).not.toBeNull();
    expect(aliceHold!.source).toBe('WAITLIST');
    expect(aliceHold!.expiresAt.getTime()).toBeGreaterThan(Date.now()); // Fresh 5 minutes!

    const aliceWaitEntry = await prisma.waitlistEntry.findFirst({
      where: { userId: aliceUser.id, productId: DEFAULT_PRODUCT_ID },
    });
    expect(aliceWaitEntry!.status).toBe('PROMOTED');

    // 5. Verify Bob advanced up to position #1
    const bobStatus = await fetch(`${baseUrl}/api/waitlist/status`, {
      headers: { 'x-user-id': 'queue-bob' },
    });
    const bobData = await bobStatus.json();
    expect(bobData.waitlist.position).toBe(1);
    expect(bobData.waitlist.ahead).toBe(0);

    // 6. Direct Hand-off check: Stock never became public!
    const inv = await prisma.inventory.findUniqueOrThrow({
      where: { productId: DEFAULT_PRODUCT_ID },
    });
    expect(inv.available).toBe(0); // Unit was handed straight to Alice
  });

  it('prevents random users from jumping the queue via Buy click while people wait', async () => {
    // Available is 0, Bob is waiting in queue
    await prisma.inventory.update({
      where: { productId: DEFAULT_PRODUCT_ID },
      data: { available: 0 },
    });

    await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'queue-bob' },
    });

    // Outside user tries to call /buy
    const buyRes = await fetch(`${baseUrl}/api/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'line-jumper-eve' },
    });

    expect(buyRes.status).toBe(409);
    expect((await buyRes.json()).error).toBe('SOLD_OUT');
  });

  it('allows voluntarily leaving the waitlist and advances following users', async () => {
    await prisma.inventory.update({
      where: { productId: DEFAULT_PRODUCT_ID },
      data: { available: 0 },
    });

    // Join Alice and Bob
    await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'leaver-alice' },
    });

    await fetch(`${baseUrl}/api/waitlist/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'patient-bob' },
    });

    // Alice leaves
    const leaveRes = await fetch(`${baseUrl}/api/waitlist/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'leaver-alice' },
    });
    expect(leaveRes.status).toBe(200);

    // Bob is now #1
    const bobRes = await fetch(`${baseUrl}/api/waitlist/status`, {
      headers: { 'x-user-id': 'patient-bob' },
    });
    const bobData = await bobRes.json();
    expect(bobData.waitlist.position).toBe(1);
    expect(bobData.waitlist.ahead).toBe(0);
    expect(bobData.waitlist.size).toBe(1);
  });
});
