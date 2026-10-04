# Sneaker Drop: System Architecture & Run Guide

Production-grade drop system built to eliminate race conditions, guarantee zero overselling under high concurrency, handle chaotic payment webhooks, and provide fair FIFO waitlist queue promotion.

---

## 1. Requirements & Prerequisites

- **Node.js**: `v20.x` or later (LTS recommended)
- **Package Manager**: `npm v10+` (uses npm workspaces)
- **Docker & Docker Compose**: For running PostgreSQL 16
- **Ports Used**:
  - `5433`: PostgreSQL (mapped to avoid default port 5432 collisions)
  - `4000`: API Server (`apps/api`)
  - `4001`: Fake Payment Provider Simulator (`apps/payments-mock`)
  - `3000`: Next.js Web Frontend (`apps/web`)

---

## 2. How to Run

### Step 1: Environment Setup
Ensure `.env` exists in the project root (copied from `.env.example`):
```bash
cp .env.example .env
```
*(Default settings configure `POSTGRES_PORT=5433`, `DATABASE_URL`, `API_PORT=4000`, `PAYMENTS_PORT=4001`, and `PAYMENT_WEBHOOK_SECRET`)*.

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Start Database
Launch the PostgreSQL 16 container:
```bash
npm run db:up
```

### Step 4: Run Migrations & Seed Data
Generate Prisma clients, apply database migrations with SQL constraints, and seed 20 pairs:
```bash
npm run db:migrate
npm run db:seed
```

### Step 5: Start the Full Development Environment
Run all services concurrently (API, Expiry Worker, Payments Mock, and Web Frontend):
```bash
npm run dev
```

Open your browser to **http://localhost:3000**.

*(Optional: To run each service individually in dedicated terminal windows, use: `npm run dev:api`, `npm run dev:worker`, `npm run dev:payments`, `npm run dev:web`)*.

---

## 3. Architecture & Process Flow

```
                               ┌────────────────────────────────┐
        Browser Client ──────► │       Next.js Web (Port 3000)   │  Polling status & actions
                               └───────────────┬────────────────┘
                                               │ rewrites /api/*
                               ┌───────────────▼────────────────┐
                               │       Express API (Port 4000)   │  Atomic buy, queue, pay, status
                               └───┬────────────────────────┬───┘
                                   │                        │ POST /charges
                                   │                        ▼
                                   │            ┌───────────────────────┐
                                   │            │  Fake Payments Mock   │  Chaos simulator (4001)
                                   │            │  (delay/dupes/order)  │
                                   │            └───────────┬───────────┘
                                   │                        │ Signed HMAC-SHA256 Webhook
                                   │                        │ POST /api/webhooks/payments
                                   ▼                        │
                        ┌─────────────────────┐  ◄──────────┘
                        │    PostgreSQL 16    │
                        │    (Port 5433)      │  Single Source of Truth
                        └──────────▲──────────┘
                                   │
                        ┌──────────┴──────────┐
                        │    Expiry Worker    │  Sweeps expired holds every 1s
                        │    (Background)     │  Promotes waitlist directly
                        └─────────────────────┘
```

### Process Roles
1. **Next.js Web App (`apps/web`)**: Clean, interactive UI polling `/api/status`. Calculates authoritative server clock offset (`serverNow - clientNow`) to eliminate client clock drift.
2. **Core API (`apps/api`)**: Handles `/api/buy`, `/api/waitlist/join`, `/api/waitlist/leave`, `/api/pay`, `/api/status`, and signed webhook ingestion.
3. **Expiry Worker (`apps/api/src/worker.ts`)**: 1-second interval daemon executing `sweepExpired()` to reclaim holds and promote waiting users.
4. **Payments Mock (`apps/payments-mock`)**: Standalone chaos gateway simulating network latency (0–5000ms), event reordering, duplicate deliveries, and simulated dropouts.
5. **PostgreSQL 16**: Enforces state integrity via row locks (`FOR UPDATE`), raw `CHECK` constraints, and partial unique indexes.

---

## 4. Data Model & Integrity Constraints

### Database Schema
- **`Product`**: Catalog item with SKU and pricing.
- **`Inventory`**: Single stock record per product (`total = 20`, `available = 20`).
- **`Hold`**: 5-minute reservations (`HELD`, `PAID`, `EXPIRED`, `CANCELLED`).
- **`WaitlistEntry`**: FIFO waiting queue (`WAITING`, `PROMOTED`, `LEFT`, `EXPIRED`).
- **`Payment`**: Payment lifecycle tracking (`CREATED`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `refundNeeded`).
- **`WebhookEvent`**: Audit log ensuring strict idempotency per `eventId`.

### Raw SQL Constraints (Migration `000_constraints`)
1. **Zero Overselling Constraints**:
   ```sql
   ALTER TABLE "Inventory" ADD CONSTRAINT "chk_inventory_available_non_negative" CHECK (available >= 0);
   ALTER TABLE "Inventory" ADD CONSTRAINT "chk_inventory_available_le_total" CHECK (available <= total);
   ```
2. **Quota Invariant (Max 1 Active Hold)**:
   ```sql
   CREATE UNIQUE INDEX "idx_holds_active_user_product" ON "Hold" ("userId", "productId") WHERE status = 'HELD';
   ```
3. **Waitlist Invariant (Max 1 Active Position)**:
   ```sql
   CREATE UNIQUE INDEX "idx_waitlist_active_user_product" ON "WaitlistEntry" ("userId", "productId") WHERE status = 'WAITING';
   ```
4. **Payment Invariant (Single Succeeded Payment)**:
   ```sql
   CREATE UNIQUE INDEX "idx_payments_active_hold_succeeded" ON "Payment" ("holdId") WHERE status = 'SUCCEEDED';
   ```

### Conservation Law
At any point in time, the system guarantees:
$$\text{available} + \text{count(status = 'HELD')} + \text{count(status = 'PAID')} \equiv \text{total (20)}$$

---

## 5. Key Engineering Decisions

### 1. Atomic Row-Locking over Application State
- **Problem**: The original site sold 51 pairs because concurrent Node processes read `stock > 0` before writing.
- **Solution**: Every stock-modifying operation begins with:
  ```sql
  SELECT id FROM "Inventory" WHERE "productId" = $1 FOR UPDATE;
  ```
  Postgres serializes concurrent transactions on the row lock. If `available == 0`, subsequent transactions are immediately rejected with `409 SOLD_OUT`.

### 2. Global Lock Ordering (Deadlock Immunity)
All transactions acquire locks in the exact same sequence:
$$\text{Inventory} \longrightarrow \text{Hold} \longrightarrow \text{WaitlistEntry} \longrightarrow \text{Payment}$$
This guarantees mathematical immunity against database deadlocks under high concurrency.

### 3. Dual-Strategy Hold Expiration (Lazy + Active Sweep)
- **Active Worker**: Background worker runs every 1 second.
- **Lazy Sweep**: Every mutating transaction (`buy`, `join`, `leave`) calls `sweepExpired(tx, productId)` inside its own locked transaction. Even if the worker experiences garbage collection pause or network lag, stale holds are reclaimed immediately before stock checks.

### 4. Direct Waitlist Queue Hand-Off (Queue-Jumping Prevention)
When a 5-minute hold expires, `releaseUnit()` checks the waitlist queue:
- **If waitlist is non-empty**: The unit is transferred directly to the first waiter (`WAITING -> PROMOTED`), creating a fresh 5-minute `Hold` for them. Stock `available` is **not** incremented.
- **If waitlist is empty**: Stock `available` is incremented by 1.
This ensures public shoppers cannot snipe pairs reserved for people waiting in line.

### 5. Webhook Idempotency & Terminal State Machine
- **Idempotency**: Webhook `eventId` values are recorded in `WebhookEvent` inside the transaction. Re-sent events trigger a unique constraint collision and exit safely with `200 OK`.
- **Terminal States**: `SUCCEEDED` and `FAILED` are terminal. Out-of-order `PROCESSING` events cannot revert a `SUCCEEDED` payment.
- **HMAC Verification**: Signatures are validated against the raw request buffer (`crypto.timingSafeEqual`) prior to JSON parsing.

### 6. Late Payment vs Expiry Race (Automatic Refund Flag)
If a user pays after their 5-minute window expires and the pair was already handed off:
- The payment transition sets `status = 'SUCCEEDED'` with `refundNeeded = true`.
- The hold remains `EXPIRED` (or given to another user).
- System logs an alert to trigger a merchant refund workflow without corrupting inventory.

### 7. Authoritative Server Clock
The frontend receives the server's ISO timestamp (`serverTime`) via `/api/status`. The client calculates `clockOffset = serverTime - Date.now()`. All countdowns render against `Date.now() + clockOffset`, preventing client device clock manipulation.

---

## 6. Testing & Validation

### Automated Unit & Integration Tests (18 tests passing)
```bash
npm test
```
- `tests/buy.concurrency.test.ts`: Fires 100 simultaneous requests on 20 pairs; verifies exactly 20 succeed (201) and 80 fail (409).
- `tests/limits.test.ts`: Verifies max 1 active hold under rapid double-clicks; asserts 3rd purchase attempt fails with `PURCHASE_LIMIT`.
- `tests/expiry-waitlist.test.ts`: Tests hold expiration, waitlist FIFO ordering, and direct hand-off without stock leakage.
- `tests/payments-mock.test.ts`: Validates HMAC signing, retries, and chaos simulator rates.
- `tests/webhook.test.ts`: Validates raw HMAC verification, duplicate event deduplication, out-of-order reordering, and late payment refund flagging.
- `tests/status.test.ts`: Confirms accurate read model stock breakdown and user state.

### High-Concurrency Load Test (500 Buyers)
Simulate a stampede of 500 concurrent shoppers over a 50-worker connection pool:
```bash
npm run load
```
*Result: ~309 req/s, exactly 20 holds granted, 480 rejected with `409 SOLD_OUT`, 0 oversold, 0 server errors.*

### Conservation Invariant Auditor
Run deep database state verification:
```bash
npm run check
```
*Asserts `available + held + paid == 20`, validates no user has > 1 hold or > 2 purchases.*

---

## 7. Video Recording Walkthrough Outline (5 to 8 Minutes)

Use this outline when recording your walkthrough demonstration:

1. **Introduction & The Problem (1:00)**:
   - State the problem: Last drop oversold 51 pairs on 20 inventory due to race conditions ("check, then update" in application code).
   - Core principle: Single source of truth in PostgreSQL using serialized row locks (`FOR UPDATE`) and database constraints.
2. **Architecture Tour (1:30)**:
   - Show the 4 services: Next.js frontend (`:3000`), Express API (`:4000`), Expiry Worker, and Fake Payments Mock (`:4001`).
   - Highlight the single lock order and raw database constraints in Prisma / SQL migration.
3. **Live Stampede Demonstration (1:30)**:
   - Run `npm run load` live in terminal (500 concurrent requests).
   - Run `npm run check` to demonstrate the invariant audit: exactly 20 holds created, conservation sum equals 20, zero errors.
4. **Interactive UI & Direct Waitlist Hand-off (1:30)**:
   - Open browser at `http://localhost:3000`.
   - Click **Buy** to show the 5-minute countdown ticking with server offset.
   - Switch user, join the waitlist, show live position in line ("#1 in line").
   - Let hold expire (or demonstrate promotion via worker) to show the waitlist user receiving the hold directly without returning to available stock.
5. **Chaotic Payment Webhooks & Edge Cases (1:00)**:
   - Trigger a payment; show HMAC verification and payment simulator logs.
   - Explain handling of duplicate webhooks, out-of-order delivery, and the `refundNeeded` flag for late arrivals.
6. **Production Scaling & Next Steps (0:30)**:
   - Explain how to scale to 100k+ users (Redis virtual waiting room / Cloudflare Waiting Room, per-product lock sharding, transactional outbox for push notifications).

---

## 8. Scaling to 100k+ Users (Production Roadmap)

| Scale Challenge | Solution |
|-----------------|----------|
| **Connection Pool Exhaustion** | Deploy an edge virtual waiting room (e.g., Cloudflare Waiting Room or Redis queue tokens) so only $N$ concurrent users hit Postgres at a time. |
| **Hot Row Contention** | Fast-path check on read replica / Redis cache before entering write transaction; per-product sharded locks. |
| **High Read Traffic** | Cache `/api/status` read model in Redis or CDN with 500ms SWR (Stale-While-Revalidate). |
| **Asynchronous Notifications** | Implement Transactional Outbox pattern (`OutboxEvent` table) to publish queue promotion emails/SMS via Kafka or RabbitMQ. |
| **Financial Reconciliation** | Daily reconciliation cron worker comparing payment gateway transaction exports against the `Payment` table. |
