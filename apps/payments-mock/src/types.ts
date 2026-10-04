export type PaymentEventType =
  | 'payment.processing'
  | 'payment.succeeded'
  | 'payment.failed';

export interface PaymentEvent {
  event_id: string;
  type: PaymentEventType;
  provider_ref: string;
  hold_id: string;
  seq: number;
  amount_cents: number;
  occurred_at: string;
}

export interface ChargeRequest {
  holdId: string;
  amountCents?: number;
  callbackUrl?: string;
  chaos?: {
    delayMs?: number;
    duplicate?: boolean;
    reorder?: boolean;
    fail?: boolean;
  };
}
