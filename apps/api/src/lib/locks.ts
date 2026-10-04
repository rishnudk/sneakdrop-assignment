import { Tx } from '../db.js';

/**
 * Locks the inventory row for the given product.
 * This is the primary concurrency barrier ensuring atomic stock checks and allocations.
 */
export async function lockInventory(tx: Tx, productId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Inventory"
    WHERE "productId" = ${productId}
    FOR UPDATE
  `;
  return locked;
}
