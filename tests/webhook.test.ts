import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../apps/api/src/db.js';
import { app } from '../apps/api/src/app.js';
import { DEFAULT_PRODUCT_ID } from '../apps/api/prisma/seed.js';
import { signPayload } from '../apps/api/src/lib/hmac.js';
import { config } from '../apps/api/src/config.js';
import { Server } from 'http';

describe('Step 7: Webhook Ingestion, Idempotency & State Machine (Rule 4)', () => {
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

  // Helper to send signed webhook
  async function postWebhook(event: Record<string, any>, signatureOverride?: string) {
    const rawBody = JSON.stringify(event);
    const signature = signatureOverride !== undefined ? signatureOverride : signPayload(rawBody, config.WEBHOOK_SECRET);

    const res = await fetch(`${baseUrl}/webhooks/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
      },
      body: rawBody,
    });

    const data = await res.json();
    return { status: res.status, data };
  }

  it('rejects webhooks with invalid HMAC signatures with 401', async () => {
    const event = {
      event_id: 'evt_fake_sig',
      type: 'payment.succeeded',
      provider_ref: 'pay_fake',
      hold_id: 'hold_fake',
      seq: 1,
      amount_cents: 18000,
      occurred_at: new Date().toISOString(),
    };

    const res = await postWebhook(event, 'invalid-signature-hex-1234');
    expect(res.status).toBe(401);
    expect(res.data.error).toBe('INVALID_SIGNATURE');
  });

  it('processes payment flow and marks hold as PAID', async () => {
    // 1. User acquires a hold
    const user = await prisma.user.create({ data: { username: 'shopper-sarah' } });
    const hold = await prisma.hold.create({
      data: {
        userId: user.id,
        productId: DEFAULT_PRODUCT_ID,
        status: 'HELD',
        expiresAt: new Date(Date.now() + 300000),
      },
    });

    // 2. User initiates payment
    const payRes = await fetch(`${baseUrl}/api/holds/${hold.id}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'shopper-sarah' },
    });
    expect(payRes.status).toBe(202);
    const payData = await payRes.json();
    const providerRef = payData.providerRef;

    // 3. Webhook: payment.processing
    const processingRes = await postWebhook({
      event_id: 'evt_proc_1',
      type: 'payment.processing',
      provider_ref: providerRef,
      hold_id: hold.id,
      seq: 1,
      amount_cents: 18000,
      occurred_at: new Date().toISOString(),
    });
    expect(processingRes.status).toBe(200);
    expect(processingRes.data.outcome).toBe('PROCESSING_APPLIED');

    // 4. Webhook: payment.succeeded
    const succeededRes = await postWebhook({
      event_id: 'evt_succ_2',
      type: 'payment.succeeded',
      provider_ref: providerRef,
      hold_id: hold.id,
      seq: 2,
      amount_cents: 18000,
      occurred_at: new Date().toISOString(),
    });
    expect(succeededRes.status).toBe(200);
    expect(succeededRes.data.outcome).toBe('APPLIED');

    // 5. DB Verification: Hold is now PAID
    const updatedHold = await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(updatedHold.status).toBe('PAID');
    expect(updatedHold.paidAt).not.toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { providerRef } });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.refundNeeded).toBe(false);
  });

  it('guarantees idempotency when identical webhooks arrive multiple times', async () => {
    // 1. Setup hold and payment
    const user = await prisma.user.create({ data: { username: 'shopper-dave' } });
    const hold = await prisma.hold.create({
      data: {
        userId: user.id,
        productId: DEFAULT_PRODUCT_ID,
        status: 'HELD',
        expiresAt: new Date(Date.now() + 300000),
      },
    });

    const payment = await prisma.payment.create({
      data: { holdId: hold.id, providerRef: 'pay_dave_ref', status: 'CREATED', lastSeq: 0 },
    });

    const event = {
      event_id: 'evt_dave_duplicate',
      type: 'payment.succeeded',
      provider_ref: payment.providerRef,
      hold_id: hold.id,
      seq: 1,
      amount_cents: 18000,
      occurred_at: new Date().toISOString(),
    };

    // Send the EXACT SAME event 5 times
    const res1 = await postWebhook(event);
    const res2 = await postWebhook(event);
    const res3 = await postWebhook(event);
    const res4 = await postWebhook(event);
    const res5 = await postWebhook(event);

    expect(res1.status).toBe(200);
    expect(res1.data.outcome).toBe('APPLIED');

    // Subsequent duplicate events return 200 OK with DUPLICATE_NOOP
    expect(res2.status).toBe(200);
    expect(res2.data.outcome).toBe('DUPLICATE_NOOP');
    expect(res3.data.outcome).toBe('DUPLICATE_NOOP');
    expect(res4.data.outcome).toBe('DUPLICATE_NOOP');
    expect(res5.data.outcome).toBe('DUPLICATE_NOOP');

    // Exactly 1 webhook event row exists in DB
    const eventCount = await prisma.webhookEvent.count({
      where: { eventId: event.event_id },
    });
    expect(eventCount).toBe(1);
  });

  it('handles out-of-order delivery correctly (succeeded arrives before processing)', async () => {
    const user = await prisma.user.create({ data: { username: 'shopper-jill' } });
    const hold = await prisma.hold.create({
      data: {
        userId: user.id,
        productId: DEFAULT_PRODUCT_ID,
        status: 'HELD',
        expiresAt: new Date(Date.now() + 300000),
      },
    });

    const payment = await prisma.payment.create({
      data: { holdId: hold.id, providerRef: 'pay_jill_ref', status: 'CREATED', lastSeq: 0 },
    });

    // 1. Seq 2 (succeeded) arrives FIRST!
    const succRes = await postWebhook({
      event_id: 'evt_jill_succ',
      type: 'payment.succeeded',
      provider_ref: payment.providerRef,
      hold_id: hold.id,
      seq: 2,
      amount_cents: 18000,
      occurred_at: new Date().toISOString(),
    });
    expect(succRes.status).toBe(200);
    expect(succRes.data.outcome).toBe('APPLIED');

    // 2. Seq 1 (processing) arrives LATER!
    const procRes = await postWebhook({
      event_id: 'evt_jill_proc',
      type: 'payment.processing',
      provider_ref: payment.providerRef,
      hold_id: hold.id,
      seq: 1, // Older seq!
      amount_cents: 18000,
      occurred_at: new Date().toISOString(),
    });
    expect(procRes.status).toBe(200);
    expect(procRes.data.outcome).toBe('STALE_IGNORED');

    // Payment remains SUCCEEDED
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(p.status).toBe('SUCCEEDED');
  });

  it('flags refundNeeded when payment arrives after the hold has expired and released', async () => {
    const user = await prisma.user.create({ data: { username: 'late-buyer' } });

    // Hold that expired 2 minutes ago
    const hold = await prisma.hold.create({
      data: {
        userId: user.id,
        productId: DEFAULT_PRODUCT_ID,
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 120000),
      },
    });

    const payment = await prisma.payment.create({
      data: { holdId: hold.id, providerRef: 'pay_late_ref', status: 'CREATED', lastSeq: 0 },
    });

    // Webhook reports payment happened AFTER hold expired
    const lateRes = await postWebhook({
      event_id: 'evt_late_succ',
      type: 'payment.succeeded',
      provider_ref: payment.providerRef,
      hold_id: hold.id,
      seq: 1,
      amount_cents: 18000,
      occurred_at: new Date().toISOString(), // Paid after hold expired
    });

    expect(lateRes.status).toBe(200);
    expect(lateRes.data.outcome).toBe('REFUND_FLAGGED');

    // Payment is flagged for refund
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(p.status).toBe('SUCCEEDED');
    expect(p.refundNeeded).toBe(true);

    // Hold is NOT resurrected into PAID
    const h = await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(h.status).toBe('EXPIRED');
  });
});
