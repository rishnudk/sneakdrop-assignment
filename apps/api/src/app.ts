import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { dropRouter } from './routes/drop.routes.js';
import { webhookRouter } from './routes/webhook.routes.js';
import { AppError } from './lib/errors.js';

export const app = express();

app.use(cors());

// Parse JSON bodies with raw buffer capture for HMAC verification
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf-8');
    },
  })
);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount drop API routes
app.use('/api', dropRouter);

// Mount payment webhook routes
app.use('/webhooks', webhookRouter);

// Centralized error handling middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
    });
    return;
  }

  // Handle unique constraint violations from database
  if (err.code === 'P2002') {
    res.status(409).json({
      error: 'CONFLICT',
      message: 'A duplicate record already exists.',
    });
    return;
  }

  console.error('[Unhandled Error]:', err);
  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected server error occurred.',
  });
});
