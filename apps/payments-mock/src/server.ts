import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { ChargeRequest } from './types.js';
import { processChargeWithChaos } from './chaos.js';

export const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'payments-mock',
    chaosConfig: {
      maxDelayMs: config.MAX_DELAY_MS,
      duplicateRate: config.DUPLICATE_RATE,
      reorderRate: config.REORDER_RATE,
      failRate: config.FAIL_RATE,
    },
  });
});

/**
 * POST /charges
 * Initiates an asynchronous simulated payment with real-world chaos.
 * Responds 202 Accepted immediately like real payment gateways (Stripe, Adyen).
 */
app.post('/charges', (req: Request, res: Response) => {
  const chargeRequest: ChargeRequest = req.body;

  if (!chargeRequest.holdId) {
    res.status(400).json({ error: 'MISSING_HOLD_ID', message: 'holdId is required' });
    return;
  }

  const providerRef = `pay_${uuidv4()}`;
  const targetWebhookUrl =
    chargeRequest.callbackUrl || `${config.API_BASE_URL}/webhooks/payments`;

  // Start asynchronous chaos simulation in background
  processChargeWithChaos(chargeRequest, providerRef, targetWebhookUrl).catch((err) => {
    console.error('[Charge Error]:', err);
  });

  res.status(202).json({
    providerRef,
    status: 'ACCEPTED',
    holdId: chargeRequest.holdId,
    message: 'Charge initiated; webhook events will follow asynchronously with simulated chaos.',
  });
});

export const server = app.listen(config.PAYMENTS_PORT, () => {
  console.log(`💳 Fake Payment Provider listening on http://localhost:${config.PAYMENTS_PORT}`);
});
