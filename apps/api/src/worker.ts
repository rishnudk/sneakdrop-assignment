import { prisma } from './db.js';
import { lockInventory } from './lib/locks.js';
import { sweepExpired } from './services/hold.service.js';
import { DEFAULT_PRODUCT_ID } from '../prisma/seed.js';

console.log('⏰ Expiry background worker started (running every 1000ms)...');

let isRunning = false;

const intervalId = setInterval(async () => {
  if (isRunning) return; // Prevent overlapping runs if a sweep takes longer than 1s
  isRunning = true;

  try {
    await prisma.$transaction(async (tx) => {
      await lockInventory(tx, DEFAULT_PRODUCT_ID);
      const swept = await sweepExpired(tx, DEFAULT_PRODUCT_ID);

      if (swept.length > 0) {
        console.log(`[Worker] Swept ${swept.length} expired hold(s) and processed waitlist promotions.`);
      }
    });
  } catch (err) {
    console.error('[Worker Error]:', err);
  } finally {
    isRunning = false;
  }
}, 1000);

async function shutdown() {
  console.log('Stopping expiry worker...');
  clearInterval(intervalId);
  await prisma.$disconnect();
  console.log('Worker exited cleanly.');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
