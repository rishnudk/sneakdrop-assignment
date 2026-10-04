import { v4 as uuidv4 } from 'uuid';
import { ChargeRequest, PaymentEvent } from './types.js';
import { sendWebhook } from './sender.js';
import { config } from './config.js';

export async function processChargeWithChaos(
  request: ChargeRequest,
  providerRef: string,
  targetWebhookUrl: string
): Promise<void> {
  const amountCents = request.amountCents || 18000;
  const chaos = request.chaos || {};

  // 1. Determine if this payment fails or succeeds
  const willFail = chaos.fail ?? Math.random() < config.FAIL_RATE;
  const terminalType = willFail ? 'payment.failed' : 'payment.succeeded';

  // 2. Generate events with strict sequence numbers
  const processingEvent: PaymentEvent = {
    event_id: `evt_${uuidv4()}`,
    type: 'payment.processing',
    provider_ref: providerRef,
    hold_id: request.holdId,
    seq: 1,
    amount_cents: amountCents,
    occurred_at: new Date().toISOString(),
  };

  const terminalEvent: PaymentEvent = {
    event_id: `evt_${uuidv4()}`,
    type: terminalType,
    provider_ref: providerRef,
    hold_id: request.holdId,
    seq: 2,
    amount_cents: amountCents,
    occurred_at: new Date().toISOString(),
  };

  // 3. Chaos: Reordering
  const shouldReorder = chaos.reorder ?? Math.random() < config.REORDER_RATE;
  let eventQueue: PaymentEvent[] = shouldReorder
    ? [terminalEvent, processingEvent] // Out-of-order! Terminal arrives before processing!
    : [processingEvent, terminalEvent];

  // 4. Chaos: Duplication
  const shouldDuplicate = chaos.duplicate ?? Math.random() < config.DUPLICATE_RATE;
  if (shouldDuplicate) {
    // Duplicate one of the events with the exact same event_id
    const duplicateTarget = Math.random() > 0.5 ? terminalEvent : processingEvent;
    // Insert duplicate immediately or at the end
    eventQueue.push({ ...duplicateTarget });
  }

  // 5. Chaos: Delay & Asynchronous Dispatch
  const baseDelay =
    chaos.delayMs !== undefined
      ? chaos.delayMs
      : Math.floor(Math.random() * config.MAX_DELAY_MS);

  // Run in background without blocking caller
  setTimeout(async () => {
    console.log(
      `[Chaos Simulator] Dispatching ${eventQueue.length} events for ${providerRef} (Reordered=${shouldReorder}, Duplicated=${shouldDuplicate}, Delay=${baseDelay}ms)...`
    );

    for (let i = 0; i < eventQueue.length; i++) {
      const event = eventQueue[i];

      // Small jitter between consecutive events
      if (i > 0) {
        await new Promise((res) => setTimeout(res, 200));
      }

      await sendWebhook(targetWebhookUrl, event);
    }
  }, baseDelay);
}
