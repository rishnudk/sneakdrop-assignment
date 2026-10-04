import crypto from 'crypto';
import { config } from '../config.js';

/**
 * Computes HMAC-SHA256 signature for a payload.
 */
export function signPayload(payload: string | Buffer, secret: string = config.WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verifies HMAC signature using constant-time comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  providedSignature: string | undefined,
  secret: string = config.WEBHOOK_SECRET
): boolean {
  if (!providedSignature) return false;

  const expectedSignature = signPayload(rawBody, secret);

  const providedBuffer = Buffer.from(providedSignature, 'utf-8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
