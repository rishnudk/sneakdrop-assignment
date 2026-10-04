import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { dropRouter } from './routes/drop.routes.js';
import { AppError } from './lib/errors.js';

export const app = express();

app.use(cors());

// Parse JSON bodies for standard API endpoints
app.use(express.json());

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount drop endpoints
app.use('/api', dropRouter);

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
