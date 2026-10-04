import { prisma } from '../apps/api/src/db.js';
import { app } from '../apps/api/src/app.js';
import { DEFAULT_PRODUCT_ID } from '../apps/api/prisma/seed.js';
import { runInvariantCheck } from './check-invariants.js';
import { Server } from 'http';
import { setGlobalDispatcher, Agent } from 'undici';

// Configure high socket limit for load-testing client
setGlobalDispatcher(
  new Agent({
    connections: 1000,
    connect: { timeout: 30000 },
  })
);

async function main() {
  const TOTAL_BUYERS = Number(process.env.CONCURRENT_USERS || 500);

  console.log('=============================================================');
  console.log(`       🚀 HIGH-CONCURRENCY FLASH SALE LOAD TEST             `);
  console.log(`       Simulating ${TOTAL_BUYERS} simultaneous buyers stampeding        `);
  console.log('=============================================================');

  // 1. Reset Database State
  console.log('\n[1/4] Resetting database to clean drop state...');
  await prisma.webhookEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.hold.deleteMany();
  await prisma.waitlistEntry.deleteMany();
  await prisma.user.deleteMany();

  await prisma.inventory.upsert({
    where: { productId: DEFAULT_PRODUCT_ID },
    update: { total: 20, available: 20 },
    create: { productId: DEFAULT_PRODUCT_ID, total: 20, available: 20 },
  });
  console.log('✓ Database clean: Stock available = 20, Total = 20');

  // 2. Resolve Target API Server
  let server: Server | null = null;
  let targetUrl = 'http://localhost:4000';

  try {
    const health = await fetch(`${targetUrl}/health`, { signal: AbortSignal.timeout(1000) });
    if (health.ok) {
      console.log(`✓ Connected to live API server at ${targetUrl}`);
    }
  } catch {
    console.log('⚡ Starting in-process API test server on ephemeral port...');
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr: any = server!.address();
        targetUrl = `http://localhost:${addr.port}`;
        console.log(`✓ Test server running at ${targetUrl}`);
        resolve();
      });
    });
  }

  // 3. Fire Concurrent Requests
  const CONCURRENCY = Number(process.env.CONCURRENCY_LIMIT || 50);
  console.log(`\n[2/4] Firing ${TOTAL_BUYERS} requests across ${CONCURRENCY} concurrent client connections...`);
  const buyers = Array.from({ length: TOTAL_BUYERS }, (_, i) => `stampede-user-${i}`);

  const startWallTime = performance.now();

  const results: any[] = new Array(buyers.length);
  let currentIndex = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (currentIndex < buyers.length) {
      const index = currentIndex++;
      const userId = buyers[index];
      const reqStart = performance.now();

      try {
        const res = await fetch(`${targetUrl}/api/buy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': userId,
          },
          body: JSON.stringify({ productId: DEFAULT_PRODUCT_ID }),
        });

        const reqDuration = performance.now() - reqStart;
        const data = await res.json();
        results[index] = {
          status: res.status,
          code: data.error || (res.status === 201 ? 'CREATED' : 'UNKNOWN'),
          durationMs: reqDuration,
        };
      } catch (err: any) {
        results[index] = {
          status: 0,
          code: 'NETWORK_ERROR',
          errorMessage: err?.message,
          errorCause: err?.cause?.message || err?.cause?.code,
          durationMs: performance.now() - reqStart,
        };
      }
    }
  });

  await Promise.all(workers);

  const totalWallTimeMs = performance.now() - startWallTime;

  // 4. Analyze Results
  console.log('\n[3/4] Analyzing Load Test Results...');
  const created = results.filter((r) => r.status === 201);
  const soldOut = results.filter((r) => r.status === 409 && r.code === 'SOLD_OUT');
  const otherErrors = results.filter((r) => r.status !== 201 && r.status !== 409);

  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const minLat = durations[0];
  const maxLat = durations[durations.length - 1];
  const avgLat = durations.reduce((acc, v) => acc + v, 0) / durations.length;
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const p99 = durations[Math.floor(durations.length * 0.99)];

  const reqPerSec = ((TOTAL_BUYERS / totalWallTimeMs) * 1000).toFixed(1);

  console.log('-------------------------------------------------------------');
  console.log(`Total Requests:          ${TOTAL_BUYERS}`);
  console.log(`Elapsed Wall Time:       ${totalWallTimeMs.toFixed(1)} ms`);
  console.log(`Throughput:              ${reqPerSec} req/sec`);
  console.log('-------------------------------------------------------------');
  console.log(`Holds Acquired (201):    ${created.length} (Expected: 20)`);
  console.log(`Sold Out Rejected (409): ${soldOut.length} (Expected: ${TOTAL_BUYERS - 20})`);
  console.log(`Other/Network Errors:    ${otherErrors.length} (Expected: 0)`);
  if (otherErrors.length > 0) {
    console.log('Sample Error Details:', JSON.stringify(otherErrors.slice(0, 3), null, 2));
  }
  console.log('-------------------------------------------------------------');
  console.log(`Latency Min:             ${minLat.toFixed(1)} ms`);
  console.log(`Latency Avg:             ${avgLat.toFixed(1)} ms`);
  console.log(`Latency P50:             ${p50.toFixed(1)} ms`);
  console.log(`Latency P95:             ${p95.toFixed(1)} ms`);
  console.log(`Latency P99:             ${p99.toFixed(1)} ms`);
  console.log(`Latency Max:             ${maxLat.toFixed(1)} ms`);
  console.log('=============================================================');

  // 5. Verification Assertions
  const isExact20Created = created.length === 20;
  const isAllOthersSoldOut = soldOut.length === TOTAL_BUYERS - 20;

  console.log('\n[4/4] Running Invariant Audit...');
  const invariantsOk = await runInvariantCheck(DEFAULT_PRODUCT_ID);

  if (server) {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }

  await prisma.$disconnect();

  if (isExact20Created && isAllOthersSoldOut && invariantsOk) {
    console.log('🎉 LOAD TEST PASSED: EXACTLY 20 PAIRS SOLD, ZERO OVERSELLING.');
    process.exit(0);
  } else {
    console.error('❌ LOAD TEST FAILED REQUIREMENTS.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal load test error:', err);
  process.exit(1);
});
