import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../db.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';

export interface StartPaymentResult {
  paymentId: string;
  providerRef: string;
  holdId: string;
  status: string;
}

/**
 * Initiates the payment process for an active hold.
 * Critical order of operations:
 * Creates the Payment row in our database BEFORE calling the external provider,
 * guaranteeing our system is ready to receive webhooks even if delivered instantly.
 */
export async function startPayment(
  userId: string,
  holdId: string,
  chaosOverrides?: Record<string, any>
): Promise<StartPaymentResult> {
  const hold = await prisma.hold.findUnique({
    where: { id: holdId },
    include: { product: true },
  });

  if (!hold) {
    throw new AppError(404, 'HOLD_NOT_FOUND', 'The requested hold was not found.');
  }

  if (hold.userId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'You do not own this hold reservation.');
  }

  if (hold.status !== 'HELD') {
    throw new AppError(
      409,
      'HOLD_NOT_ACTIVE',
      `Hold is not active (current status: ${hold.status}).`
    );
  }

  if (hold.expiresAt.getTime() <= Date.now()) {
    throw new AppError(409, 'HOLD_EXPIRED', 'This hold has expired.');
  }

  // Check if a payment has already succeeded for this hold
  const existingSuccess = await prisma.payment.findFirst({
    where: { holdId, status: 'SUCCEEDED' },
  });

  if (existingSuccess) {
    throw new AppError(409, 'ALREADY_PAID', 'This hold has already been paid.');
  }

  const providerRef = `pay_${uuidv4()}`;

  // 1. Persist the Payment record first in our database
  const payment = await prisma.payment.create({
    data: {
      holdId: hold.id,
      providerRef,
      status: 'CREATED',
      lastSeq: 0,
    },
  });

  // 2. Call the fake payment provider (or real gateway)
  try {
    const response = await fetch(`${config.PAYMENTS_BASE_URL}/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdId: hold.id,
        providerRef,
        amountCents: hold.product.priceCents,
        callbackUrl: `${config.API_BASE_URL}/webhooks/payments`,
        chaos: chaosOverrides,
      }),
    });

    if (!response.ok && response.status !== 202) {
      console.error(`[Payment Service] Gateway returned status ${response.status}`);
    }
  } catch (err: any) {
    console.warn(`[Payment Service] Gateway call failed or deferred: ${err.message}`);
    // Payment record is persisted; gateway or mock will retry or deliver asynchronously
  }

  return {
    paymentId: payment.id,
    providerRef,
    holdId: hold.id,
    status: payment.status,
  };
}
