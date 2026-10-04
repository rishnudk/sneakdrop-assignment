import crypto from 'crypto';
import { PaymentEvent } from './types.js';
import { config } from './config.js';

export function signPayload(payload: string, secret: string = config.WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Sends a signed webhook event to the API webhook receiver.
 * Implements exponential backoff retries if the receiver is temporarily busy or unavailable.
 */
export async function sendWebhook(
  url: string,
  event: PaymentEvent,
  maxRetries = 5
): Promise<{ success: boolean; status?: number; error?: string }> {
  const payloadString = JSON.stringify(event);
  const signature = signPayload(payloadString, config.WEBHOOK_SECRET);

  let attempt = 0;
  let delay = 500;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'User-Agent': 'SneakerDrop-PaymentsMock/1.0',
        },
        body: payloadString,
      });

      if (response.ok) {
        return { success: true, status: response.status };
      }

      // If receiver returns a client/server error that should be retried (e.g. 409 or 5xx)
      if (response.status === 409 || response.status >= 500) {
        console.warn(
          `[Webhook Sender] Attempt ${attempt} failed with status ${response.status}. Retrying in ${delay}ms...`
        );
      } else {
        // Non-retriable client error (e.g. 401 unauthorized or 400 bad request)
        return {
          success: false,
          status: response.status,
          error: `Non-retriable status: ${response.status}`,
        };
      }
    } catch (err: any) {
      console.warn(
        `[Webhook Sender] Attempt ${attempt} network error: ${err.message}. Retrying in ${delay}ms...`
      );
    }

    if (attempt < maxRetries) {
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2; // exponential backoff
    }
  }

  return { success: false, error: `Exhausted ${maxRetries} retry attempts` };
}
