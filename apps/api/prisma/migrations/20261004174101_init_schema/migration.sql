-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('HELD', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HoldSource" AS ENUM ('DIRECT', 'WAITLIST');

-- CreateEnum
CREATE TYPE "WaitStatus" AS ENUM ('WAITING', 'PROMOTED', 'LEFT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "available" INTEGER NOT NULL,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hold" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'HELD',
    "source" "HoldSource" NOT NULL DEFAULT 'DIRECT',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "WaitStatus" NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "refundNeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Inventory_productId_key" ON "Inventory"("productId");

-- CreateIndex
CREATE INDEX "Hold_status_expiresAt_idx" ON "Hold"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Hold_userId_status_idx" ON "Hold"("userId", "status");

-- CreateIndex
CREATE INDEX "Hold_productId_status_idx" ON "Hold"("productId", "status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_productId_status_seq_idx" ON "WaitlistEntry"("productId", "status", "seq");

-- CreateIndex
CREATE INDEX "WaitlistEntry_userId_productId_status_idx" ON "WaitlistEntry"("userId", "productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerRef_key" ON "Payment"("providerRef");

-- CreateIndex
CREATE INDEX "Payment_holdId_idx" ON "Payment"("holdId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hold" ADD CONSTRAINT "Hold_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hold" ADD CONSTRAINT "Hold_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "Hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================================
-- SENIOR ARCHITECTURE: Invariants & Race-Condition Defense Constraints
-- =========================================================================

-- 1. Database-level refusal to oversell: available must be between 0 and total
ALTER TABLE "Inventory" ADD CONSTRAINT "inventory_available_nonneg" CHECK ("available" >= 0);
ALTER TABLE "Inventory" ADD CONSTRAINT "inventory_available_le_total" CHECK ("available" <= "total");

-- 2. Rule 2: A user can have at most ONE active hold per product
CREATE UNIQUE INDEX "one_active_hold_per_user"
  ON "Hold" ("userId", "productId") WHERE status = 'HELD';

-- 3. Rule 3: A user can be in the queue at most once per product
CREATE UNIQUE INDEX "one_waiting_entry_per_user"
  ON "WaitlistEntry" ("userId", "productId") WHERE status = 'WAITING';

-- 4. Financial integrity: At most one SUCCEEDED payment per hold (double-charge defense)
CREATE UNIQUE INDEX "one_success_per_hold"
  ON "Payment" ("holdId") WHERE status = 'SUCCEEDED';

