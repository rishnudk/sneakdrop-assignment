import { prisma, Tx } from '../db.js';
import { AppError } from '../lib/errors.js';
import { releaseUnit } from './hold.service.js';

export interface WebhookEventPayload {
  event_id: string;
  type: 'payment.processing' | 'payment.succeeded' | 'payment.failed';
  provider_ref: string;
  hold_id: string;
  seq: number;
  amount_cents: number;
  occurred_at: string;
}

export type WebhookOutcome =
  | 'APPLIED'
  | 'DUPLICATE_NOOP'
  | 'STALE_IGNORED'
  | 'REFUND_FLAGGED'
  | 'FAILED_APPLIED'
  | 'PROCESSING_APPLIED';

/**
 * Handles incoming payment webhook events with strict transactional integrity.
 * Guarantees:
 *  - Idempotency (duplicate events are no-ops)
 *  - Resilient to out-of-order delivery
 *  - Expired hold policy (flags refundNeeded if shoe was lost to timeout)
 */
export async function handlePaymentEvent(
  evt: WebhookEventPayload
): Promise<{ outcome: WebhookOutcome; eventId: string }> {
  return prisma.$transaction(async (tx) => {
    // 1. Transactional Idempotency: Unique eventId insertion
    const inserted = await tx.$executeRaw`
      INSERT INTO "WebhookEvent" ("eventId", type, payload, "receivedAt")
      VALUES (
        ${evt.event_id},
        ${evt.type},
        ${JSON.stringify(evt)}::jsonb,
        now()
      )
      ON CONFLICT ("eventId") DO NOTHING
    `;

    if (inserted === 0) {
      // Event already recorded and processed! Return 200 OK without re-applying.
      return { outcome: 'DUPLICATE_NOOP', eventId: evt.event_id };
    }

    let [payment] = await tx.$queryRaw<
      {
        id: string;
        holdId: string;
        providerRef: string;
        status: string;
        lastSeq: number;
        refundNeeded: boolean;
      }[]
    >`
      SELECT * FROM "Payment"
      WHERE "providerRef" = ${evt.provider_ref}
      FOR UPDATE
    `;

    // Fallback lookup by holdId if providerRef was generated differently
    if (!payment && evt.hold_id) {
      const [byHold] = await tx.$queryRaw<
        {
          id: string;
          holdId: string;
          providerRef: string;
          status: string;
          lastSeq: number;
          refundNeeded: boolean;
        }[]
      >`
        SELECT * FROM "Payment"
        WHERE "holdId" = ${evt.hold_id}
        ORDER BY "createdAt" DESC
        LIMIT 1
        FOR UPDATE
      `;
      if (byHold) {
        payment = byHold;
      }
    }

    if (!payment) {
      // Payment row was not found (e.g. webhook raced ahead of DB insert)
      // Throw 409 so transaction rolls back and provider retries with backoff!
      throw new AppError(409, 'PAYMENT_UNKNOWN', 'Payment record not found; please retry.');
    }

    // 3. State Machine & Staleness Check
    // Terminal states never revert
    if (payment.status === 'SUCCEEDED' || payment.status === 'FAILED') {
      await updateWebhookOutcome(tx, evt.event_id, 'STALE_IGNORED');
      return { outcome: 'STALE_IGNORED', eventId: evt.event_id };
    }

    // Out-of-order non-terminal event (e.g. seq 1 processing arriving after seq 2 succeeded)
    if (evt.seq <= payment.lastSeq && evt.type !== 'payment.succeeded') {
      await updateWebhookOutcome(tx, evt.event_id, 'STALE_IGNORED');
      return { outcome: 'STALE_IGNORED', eventId: evt.event_id };
    }

    // 4. State Transitions
    if (evt.type === 'payment.succeeded') {
      return applySuccess(tx, payment, evt);
    } else if (evt.type === 'payment.failed') {
      return applyFailure(tx, payment, evt);
    } else {
      return applyProcessing(tx, payment, evt);
    }
  });
}

async function applySuccess(
  tx: Tx,
  payment: { id: string; holdId: string; lastSeq: number },
  evt: WebhookEventPayload
) {
  // Lock the hold record for update
  const [hold] = await tx.$queryRaw<
    {
      id: string;
      productId: string;
      userId: string;
      status: string;
      expiresAt: Date;
    }[]
  >`
    SELECT * FROM "Hold"
    WHERE id = ${payment.holdId}
    FOR UPDATE
  `;

  if (hold.status === 'PAID') {
    // Hold was already paid by another transaction/event -> flag refund
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', lastSeq: evt.seq, refundNeeded: true },
    });
    await updateWebhookOutcome(tx, evt.event_id, 'REFUND_FLAGGED');
    return { outcome: 'REFUND_FLAGGED' as WebhookOutcome, eventId: evt.event_id };
  }

  // Payment is valid if occurred before expiration and hold is still active
  const occurredAt = new Date(evt.occurred_at);
  const paidInTime = hold.status === 'HELD' && occurredAt <= hold.expiresAt;

  if (paidInTime) {
    // Normal happy path: Convert hold to PAID
    await tx.hold.update({
      where: { id: hold.id },
      data: { status: 'PAID', paidAt: occurredAt },
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', lastSeq: evt.seq, refundNeeded: false },
    });

    await updateWebhookOutcome(tx, evt.event_id, 'APPLIED');
    return { outcome: 'APPLIED' as WebhookOutcome, eventId: evt.event_id };
  }

  // LATE PAYMENT POLICY:
  // The hold has expired or was already cancelled/given to the waitlist.
  // We NEVER oversell or steal the shoe from a promoted waiter.
  // Instead, we mark the payment SUCCEEDED and flag refundNeeded = true.
  await tx.payment.update({
    where: { id: payment.id },
    data: { status: 'SUCCEEDED', lastSeq: evt.seq, refundNeeded: true },
  });

  // If the hold was still in HELD status (sweep hadn't run yet), officially expire it now
  if (hold.status === 'HELD') {
    await tx.hold.update({
      where: { id: hold.id },
      data: { status: 'EXPIRED' },
    });
    // Hand unit off to waitlist or restore to stock
    await releaseUnit(tx, hold.productId);
  }

  await updateWebhookOutcome(tx, evt.event_id, 'REFUND_FLAGGED');
  return { outcome: 'REFUND_FLAGGED' as WebhookOutcome, eventId: evt.event_id };
}

async function applyFailure(
  tx: Tx,
  payment: { id: string; holdId: string; lastSeq: number },
  evt: WebhookEventPayload
) {
  await tx.payment.update({
    where: { id: payment.id },
    data: { status: 'FAILED', lastSeq: evt.seq },
  });

  // If hold is still held, cancel it early so the waitlist gets the shoe immediately
  const [hold] = await tx.$queryRaw<{ id: string; productId: string; status: string }[]>`
    SELECT id, "productId", status FROM "Hold" WHERE id = ${payment.holdId} FOR UPDATE
  `;

  if (hold && hold.status === 'HELD') {
    await tx.hold.update({
      where: { id: hold.id },
      data: { status: 'CANCELLED' },
    });
    await releaseUnit(tx, hold.productId);
  }

  await updateWebhookOutcome(tx, evt.event_id, 'FAILED_APPLIED');
  return { outcome: 'FAILED_APPLIED' as WebhookOutcome, eventId: evt.event_id };
}

async function applyProcessing(
  tx: Tx,
  payment: { id: string; lastSeq: number },
  evt: WebhookEventPayload
) {
  await tx.payment.update({
    where: { id: payment.id },
    data: { status: 'PROCESSING', lastSeq: Math.max(payment.lastSeq, evt.seq) },
  });

  await updateWebhookOutcome(tx, evt.event_id, 'PROCESSING_APPLIED');
  return { outcome: 'PROCESSING_APPLIED' as WebhookOutcome, eventId: evt.event_id };
}

async function updateWebhookOutcome(tx: Tx, eventId: string, outcome: WebhookOutcome) {
  await tx.webhookEvent.update({
    where: { eventId },
    data: { processedAt: new Date(), outcome },
  });
}
