import { PrismaClient } from '@prisma/client';
import { config } from '../src/config.js';

const prisma = new PrismaClient();

export const DEFAULT_PRODUCT_ID = '00000000-0000-0000-0000-000000000001';

export async function seed() {
  console.log('--- Seeding Sneaker Drop Database ---');

  // 1. Upsert Default Sneaker Product
  const product = await prisma.product.upsert({
    where: { id: DEFAULT_PRODUCT_ID },
    update: {
      name: 'Air Velocity Retro Drop #1',
      priceCents: 18000,
    },
    create: {
      id: DEFAULT_PRODUCT_ID,
      name: 'Air Velocity Retro Drop #1',
      priceCents: 18000,
    },
  });
  console.log(`Product ready: "${product.name}" (${product.id})`);

  // 2. Upsert Inventory for Product (20 units total)
  const inventory = await prisma.inventory.upsert({
    where: { productId: product.id },
    update: {
      total: config.TOTAL_STOCK,
      available: config.TOTAL_STOCK,
    },
    create: {
      productId: product.id,
      total: config.TOTAL_STOCK,
      available: config.TOTAL_STOCK,
    },
  });
  console.log(`Inventory ready: Total=${inventory.total}, Available=${inventory.available}`);

  console.log('--- Seed Completed Successfully ---');
}

seed()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
