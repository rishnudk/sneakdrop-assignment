import { app } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

const server = app.listen(config.API_PORT, () => {
  console.log(`🚀 Sneaker Drop API server listening on http://localhost:${config.API_PORT}`);
});

async function shutdown() {
  console.log('Shutting down API server...');
  server.close(async () => {
    await prisma.$disconnect();
    console.log('Database connection closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
