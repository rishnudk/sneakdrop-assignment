import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

// Global serialization patch for BigInt (needed for WaitlistEntry.seq)
if (!(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return Number(this);
  };
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (config.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
