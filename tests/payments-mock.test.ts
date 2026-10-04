import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Server } from 'http';
import { signPayload, sendWebhook } from '../apps/payments-mock/src/sender.js';
import { processChargeWithChaos } from '../apps/payments-mock/src/chaos.js';
import { PaymentEvent } from '../apps/payments-mock/src/types.js';
import { config } from '../apps/payments-mock/src/config.js';

describe('Step 6: Fake Payment Provider & Chaos Simulator (Rule 4)', () => {
  let receiverServer: Server;
  let receiverUrl: string;
  let receivedEvents: { signature: string; event: PaymentEvent; rawBody: string }[] = [];

  beforeAll(async () => {
    const receiverApp = express();

    // Capture raw body for signature verification
    receiverApp.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf.toString();
        },
      })
    );

    receiverApp.post('/test-webhook', (req: any, res) => {
      receivedEvents.push({
        signature: req.headers['x-signature'] as string,
        event: req.body,
        rawBody: req.rawBody,
      });
      res.status(200).json({ received: true });
    });

    await new Promise<void>((resolve) => {
      receiverServer = receiverApp.listen(0, () => {
        const addr: any = receiverServer.address();
        receiverUrl = `http://localhost:${addr.port}/test-webhook`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
  });

  it('signs webhooks with valid HMAC-SHA256 signature', async () => {
    receivedEvents = [];

    const testEvent: PaymentEvent = {
      event_id: 'evt_test_123',
      type: 'payment.succeeded',
      provider_ref: 'pay_test_ref',
      hold_id: 'hold_xyz',
      seq: 2,
      amount_cents: 18000,
      occurred_at: new Date().toISOString(),
    };

    const result = await sendWebhook(receiverUrl, testEvent);
    expect(result.success).toBe(true);
    expect(receivedEvents.length).toBe(1);

    const received = receivedEvents[0];
    const expectedSignature = signPayload(received.rawBody, config.WEBHOOK_SECRET);
    expect(received.signature).toBe(expectedSignature);
  });

  it('simulates out-of-order delivery when reorder chaos is enabled', async () => {
    receivedEvents = [];

    await processChargeWithChaos(
      {
        holdId: 'hold_reorder_test',
        chaos: {
          delayMs: 10,
          reorder: true, // Force reorder
          duplicate: false,
          fail: false,
        },
      },
      'pay_reorder_ref',
      receiverUrl
    );

    // Wait for events to be dispatched
    await new Promise((res) => setTimeout(res, 500));

    expect(receivedEvents.length).toBe(2);
    // When reordered: seq 2 (succeeded) arrives BEFORE seq 1 (processing)!
    expect(receivedEvents[0].event.seq).toBe(2);
    expect(receivedEvents[0].event.type).toBe('payment.succeeded');
    expect(receivedEvents[1].event.seq).toBe(1);
    expect(receivedEvents[1].event.type).toBe('payment.processing');
  });

  it('simulates duplicate event delivery when duplicate chaos is enabled', async () => {
    receivedEvents = [];

    await processChargeWithChaos(
      {
        holdId: 'hold_duplicate_test',
        chaos: {
          delayMs: 10,
          reorder: false,
          duplicate: true, // Force duplicate
          fail: false,
        },
      },
      'pay_duplicate_ref',
      receiverUrl
    );

    // Wait for events to be dispatched
    await new Promise((res) => setTimeout(res, 500));

    expect(receivedEvents.length).toBe(3); // 2 regular events + 1 duplicate!
    const eventIds = receivedEvents.map((r) => r.event.event_id);
    const uniqueEventIds = new Set(eventIds);

    // At least one event ID must be duplicated!
    expect(uniqueEventIds.size).toBeLessThan(eventIds.length);
  });
});
