import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Support loading root .env if not already loaded by runner
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().url().default('postgresql://drop:drop@localhost:5433/drop'),
  API_PORT: z.coerce.number().default(4000),
  PAYMENTS_PORT: z.coerce.number().default(4001),
  WEB_PORT: z.coerce.number().default(3000),
  HOLD_TTL_SECONDS: z.coerce.number().default(300),
  TOTAL_STOCK: z.coerce.number().default(20),
  PURCHASE_LIMIT: z.coerce.number().default(2),
  WEBHOOK_SECRET: z.string().default('super-secret-webhook-key-12345'),
  PAYMENTS_BASE_URL: z.string().default('http://localhost:4001'),
  API_BASE_URL: z.string().default('http://localhost:4000'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
