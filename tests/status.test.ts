import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../apps/api/src/db.js';
import { app } from '../apps/api/src/app.js';
import { DEFAULT_PRODUCT_ID } from '../apps/api/prisma/seed.js';
import { Server } from 'http';

describe('Step 8: Status Read Model & Invariant Verification (Rule 5)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address: any = server.address();
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.webhookEvent.deleteMany();
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

  it('GET /api/status returns accurate stock breakdown, server timestamp, and user state', async () => {
    // 1. Initial status
    const resInitial = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-user-id': 'status-tester-1' },
    });
    expect(resInitial.status).toBe(200);
    const dataInitial = await resInitial.json();

    expect(dataInitial.stock.total).toBe(20);
    expect(dataInitial.stock.available).toBe(20);
    expect(dataInitial.stock.held).toBe(0);
    expect(dataInitial.stock.paid).toBe(0);
    expect(dataInitial.me.purchased).toBe(0);
    expect(dataInitial.me.hold).toBeNull();
    expect(dataInitial.me.waitlist).toBeNull();
    expect(new Date(dataInitial.serverNow).getTime()).toBeGreaterThan(0);

    // 2. User buys a pair
    const buyRes = await fetch(`${baseUrl}/api/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'status-tester-1' },
    });
    expect(buyRes.status).toBe(201);

    // 3. Status after buy
    const resAfterBuy = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-user-id': 'status-tester-1' },
    });
    expect(resAfterBuy.status).toBe(200);
    const dataAfterBuy = await resAfterBuy.json();

    expect(dataAfterBuy.stock.available).toBe(19);
    expect(dataAfterBuy.stock.held).toBe(1);
    expect(dataAfterBuy.me.hold).not.toBeNull();
    expect(dataAfterBuy.me.hold.status).toBe('HELD');
    expect(dataAfterBuy.me.hold.secondsLeft).toBeGreaterThan(280); // ~300s
  });

  it('GET /api/admin/invariants confirms mathematical conservation', async () => {
    const res = await fetch(`${baseUrl}/api/admin/invariants`, {
      headers: { 'x-user-id': 'admin' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.total).toBe(20);
    expect(data.sum).toBe(20);
    expect(data.usersWithMultipleHolds).toBe(0);
    expect(data.usersOverLimit).toBe(0);
  });
});
