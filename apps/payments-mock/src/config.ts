import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config();

const envSchema = z.object({
  PAYMENTS_PORT: z.coerce.number().default(4001),
  API_BASE_URL: z.string().default('http://localhost:4000'),
  WEBHOOK_SECRET: z.string().default('super-secret-webhook-key-12345'),
  MAX_DELAY_MS: z.coerce.number().default(8000),
  DUPLICATE_RATE: z.coerce.number().default(0.3),
  REORDER_RATE: z.coerce.number().default(0.3),
  FAIL_RATE: z.coerce.number().default(0.1),
});

export const config = envSchema.parse(process.env);
export type PaymentsConfig = z.infer<typeof envSchema>;
