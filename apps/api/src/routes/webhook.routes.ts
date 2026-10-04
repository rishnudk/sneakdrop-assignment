import { Router, Request, Response, NextFunction } from 'express';
import { verifyWebhookSignature } from '../lib/hmac.js';
import { handlePaymentEvent } from '../services/webhook.service.js';

export const webhookRouter = Router();

/**
 * POST /webhooks/payments
 * Ingests signed payment events from the payment gateway.
 */
webhookRouter.post('/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);
    const signature = (req.headers['x-signature'] as string) || (req.headers['x-webhook-signature'] as string);

    // 1. Verify HMAC Signature
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      console.warn('[Webhook Routes] Rejected webhook with invalid or missing HMAC signature');
      res.status(401).json({ error: 'INVALID_SIGNATURE', message: 'HMAC signature verification failed.' });
      return;
    }

    // 2. Process event via transactional state machine
    const result = await handlePaymentEvent(req.body);

    res.status(200).json({
      received: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});
