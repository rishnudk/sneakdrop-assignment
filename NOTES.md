# Sneaker Drop: System Architecture, Run Guide & Features

A production-grade drop reservation engine built to eliminate race conditions, guarantee zero overselling under massive concurrency, handle chaotic payment webhooks, and provide fair FIFO waitlist queue promotions.

---

## 1. System Requirements & Prerequisites

Before running the application, make sure your environment has:

| Requirement | Supported Versions | Notes |
| :--- | :--- | :--- |
| **Node.js** | `v20.x` or later (LTS recommended) | Engine runtime |
| **npm** | `v10.x` or later | Monorepo uses `npm` workspaces |
| **Docker & Docker Desktop** | Latest | Runs containerized PostgreSQL 16 |
| **Operating System** | Windows (PowerShell / CMD), macOS, Linux | Cross-platform scripts and path handling |

### Ports Utilized
- **`5433`**: PostgreSQL 16 database (mapped from container 5432 to avoid local PostgreSQL collisions)
- **`4000`**: Express Core API (`apps/api`)
- **`4001`**: Fake Payment Provider Chaos Simulator (`apps/payments-mock`)
- **`3000`**: Next.js 14 Frontend Application (`apps/web`)

---

## 2. Quickstart: How to Run

### Step 1: Environment Configuration
Ensure `.env` exists in the repository root. A pre-configured `.env` is included in the project; if missing, copy from `.env.example`:
```bash
cp .env.example .env
```
*(Default settings configure `POSTGRES_PORT=5433`, `DATABASE_URL="postgresql://drop:drop@localhost:5433/drop"`, `API_PORT=4000`, `PAYMENTS_PORT=4001`, `WEBHOOK_SECRET`, and chaos simulator parameters).*

### Step 2: Install Dependencies
From the repository root, install dependencies for all workspaces:
```bash
npm install
```

### Step 3: Start PostgreSQL Container
Launch the PostgreSQL 16 container via Docker Compose:
```bash
npm run db:up
```
*(To verify database is healthy: `docker compose ps`)*

### Step 4: Apply Database Migrations & Seed Initial Stock
Run Prisma migrations (creates tables, SQL constraints, partial unique indexes) and seeds the initial 20 sneakers:
```bash
npm run db:migrate
npm run db:seed
```

### Step 5: Start the Full Development Environment
Run all 4 services concurrently in one terminal with color-coded logs:
```bash
npm run dev
```

Open your browser to: **http://localhost:3000**

---

## 3. Running Services Individually (Optional)

If you prefer dedicated terminal windows for each service during debugging or demonstration:

```bash
# Terminal 1: Core Express API
npm run dev:api

# Terminal 2: Background Hold Expiry & Waitlist Promotion Worker
npm run dev:worker

# Terminal 3: Fake Payment Gateway Chaos Simulator
npm run dev:pay

# Terminal 4: Next.js Frontend Dashboard
npm run dev:web
```

---

## 4. Key Features & Capabilities

### ⚡ 1. Zero-Oversell Concurrency Guarantee (Rule 1 & 2)
- **Atomic Row Locking (`SELECT ... FOR UPDATE`)**: All stock allocation operations serialize on PostgreSQL row locks, completely eliminating the "check-then-update" race condition that caused the original 51-pair overselling disaster.
- **SQL Defense Constraints**: Database-level check constraints `CHECK (available >= 0)` and `CHECK (available <= total)` prevent overselling even if application code were compromised.
- **User Quotas**: Enforces maximum **1 active hold** per shopper and maximum **2 lifetime purchases** per shopper.

### ⏱️ 2. 5-Minute Hold State Machine & Dual-Strategy Expiry
- When a user clicks **Buy**, 1 pair is atomically held for **5 minutes** (300 seconds).
- **Dual Expiry Engine**:
  - **Active Background Worker (`apps/api/src/worker.ts`)**: Sweeps expired holds every 1 second.
  - **Lazy Sweep**: Every stock-modifying endpoint calls `sweepExpired()` within its locked transaction. Even if the background worker pauses, holds never linger past expiration.
- **Clamped Inventory Safety**: `SET available = LEAST(total, available + 1)` guarantees stock increments never exceed 20, preventing constraint errors.

### 🎟️ 3. Direct Waitlist Queue Promotion (Rule 3)
- When stock reaches 0, shoppers can join a FIFO waiting line (`WaitlistEntry` with `seq` autoincrement).
- **Direct Hand-Off**: When someone's 5-minute hold expires or payment fails, the freed sneaker is handed **directly** to the first eligible person in line (`WAITING -> PROMOTED`), starting their fresh 5-minute timer.
- **Sniper Immunity**: The unit is **never** returned to the public stock pool while people are waiting in line. Outside shoppers cannot jump ahead of waitlisted users.

### 💳 4. Chaos-Resilient Payment Gateway & Webhook Engine (Rule 4)
- **Simulated Gateway (`apps/payments-mock`)**: Simulates real-world payment networks with configurable delays (0–8s), network drops, and retries.
- **Idempotent Webhook Receiver**: Records every `eventId` in `WebhookEvent` table; duplicate webhook deliveries return `200 OK` with zero side-effects.
- **Out-of-Order Delivery**: Uses sequence tracking (`lastSeq`) and terminal state machines (`SUCCEEDED`/`FAILED` never revert to `PROCESSING`).
- **Cryptographic Security**: HMAC-SHA256 signature verification over raw request buffers using constant-time comparison (`crypto.timingSafeEqual`).
- **Late Payment Policy**: If a payment webhook arrives after the 5-minute hold expired and the shoe was given to the waitlist, the payment is marked `SUCCEEDED` with `refundNeeded = true` to trigger an automated refund rather than stealing the unit from the promoted waiter.

### 🚀 5. In-App Flash Sale Concurrency Simulator (Demo Feature)
- **One-Click Rush Simulation**: Click **"🚀 Simulate 30 Buyers at Once"** in the web dashboard or call `POST /api/admin/simulate-rush`:
  - Fires 30 concurrent shoppers hitting `buy()` at the exact same millisecond.
  - **Exactly 20 secure holds** (`201 Created`).
  - **Exactly 10 are rejected** (`409 SOLD_OUT`) and automatically enter the FIFO waiting queue (`WAITING`).
  - Displays instant benchmark runtime (e.g. `~180ms`) and quick-switch buttons for all 30 shoppers.
- **One-Click Drop Reset**: Click **"🔄 Reset Drop (20 Pairs)"** or call `POST /api/admin/reset` to restore a clean 20-pair initial state anytime during video demonstrations.

### 📱 6. Real-Time Drop Dashboard (Rule 5)
- **Drop Metrics**: Displays live stock counts (`Available`, `In Checkout (Held)`, `Completed (Paid)`, and `Your Purchases (X / 2)`).
- **Authoritative Server Clock Countdown**: Computes `serverOffset = serverNow - Date.now()` on every poll to ensure the 5-minute countdown is exact, even if the user's laptop clock is wrong.
- **Shopper Switcher**: Quick-switch buttons (`buyer-1`, `buyer-2`, `rush-shopper-1`, `rush-shopper-25`) allow painless demonstration of multiple shoppers without logging in/out.
- **1-Click Buy & Instant Pay Shortcut**: Enables rapid testing of the complete reserve $\rightarrow$ pay $\rightarrow$ confirmation lifecycle.

---

## 5. System Architecture

```
                               ┌────────────────────────────────┐
        Browser Client ──────► │    Next.js Web Dashboard       │  Polls /api/status every 1.5s
                               │         (Port 3000)            │  Server clock offset calculation
                               └───────────────┬────────────────┘
                                               │ rewrites /api/*
                               ┌───────────────▼────────────────┐
                               │       Express API Server       │  Atomic buy, waitlist, payments
                               │         (Port 4000)            │  HMAC webhook authentication
                               └───┬────────────────────────┬───┘
                                   │                        │ POST /charges (holdId, providerRef)
                                   │                        ▼
                                   │            ┌───────────────────────┐
                                   │            │  Fake Payments Mock   │  Chaos simulator (Port 4001)
                                   │            │  (delays, dupes, seq) │
                                   │            └───────────┬───────────┘
                                   │                        │ Signed HMAC-SHA256 Webhook
                                   │                        │ POST /webhooks/payments
                                   ▼                        │
                        ┌─────────────────────┐  ◄──────────┘
                        │    PostgreSQL 16    │
                        │     (Port 5433)     │  Row locks (FOR UPDATE), CHECK constraints
                        └──────────▲──────────┘
                                   │
                        ┌──────────┴──────────┐
                        │    Expiry Worker    │  Sweeps expired holds every 1s
                        │    (apps/api/src)   │  Promotes waitlist directly
                        └─────────────────────┘
```

### Global Lock Order (Deadlock Immunity)
To guarantee deadlock prevention across all concurrent transactions, operations lock entities in a strictly enforced global order:
$$\text{Inventory} \longrightarrow \text{Hold} \longrightarrow \text{WaitlistEntry} \longrightarrow \text{Payment}$$

### Global Conservation Invariant
At all times across all states, the database guarantees:
$$\text{available} + \text{count(status = 'HELD')} + \text{count(status = 'PAID')} \equiv \text{total (20)}$$

---

## 6. Testing & Verification

### 1. Automated Integration & Concurrency Tests (Vitest)
Run the full 18-test suite against real PostgreSQL transactions:
```bash
npm test
```
- `tests/buy.concurrency.test.ts`: Simulates 100 simultaneous Buy clicks $\rightarrow$ exactly 20 succeed, 80 receive `SOLD_OUT`.
- `tests/limits.test.ts`: Verifies max 1 active hold under rapid double-clicks and asserts 3rd purchase attempt fails with `PURCHASE_LIMIT`.
- `tests/expiry-waitlist.test.ts`: Verifies hold expiration, FIFO queue ordering, and direct hand-off without stock leakage.
- `tests/webhook.test.ts`: Tests HMAC verification, duplicate event deduplication, out-of-order event reordering, and late payment refund flagging.
- `tests/payments-mock.test.ts`: Validates webhook dispatching, retry backoff, and signature verification.
- `tests/status.test.ts`: Asserts read-model consistency and invariant equations.

### 2. High-Concurrency Flash Sale Stampede (500 Buyers)
Run the stress test script to simulate a stampede of 500 simultaneous shoppers over 50 client connections:
```bash
npm run load
```
*Expected output: ~300+ req/s, exactly 20 holds granted, 480 rejected with `409 SOLD_OUT`, 0 oversold, 0 server errors.*

### 3. Conservation Invariant Auditor
Run deep mathematical invariant verification against the live database:
```bash
npm run check
```
*Asserts `available + held + paid == 20`, validates no user has > 1 active hold, and verifies no user bought > 2 pairs.*

---

## 7. Useful API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/status` | Read model: available stock breakdown, user hold details, countdown, and waitlist position |
| `POST` | `/api/buy` | Atomically reserve a 5-minute hold on a pair (Headers: `x-user-id: <username>`) |
| `POST` | `/api/holds/:id/pay` | Initiate payment for an active hold (optional chaos overrides in body) |
| `POST` | `/api/waitlist/join` | Join the FIFO waiting line when available stock is 0 |
| `POST` | `/api/waitlist/leave` | Voluntarily leave the waiting line |
| `POST` | `/webhooks/payments` | Secure signed HMAC-SHA256 webhook receiver for payment events |
| `POST` | `/api/admin/simulate-rush` | Simulate $N$ concurrent buyers hitting the buy endpoint at the exact same millisecond |
| `POST` | `/api/admin/reset` | Reset drop to clean initial state (20 available, no holds, no waitlist) |
| `GET` | `/api/admin/invariants` | Verify conservation invariants directly via SQL |

---

## 8. Screen Recording Walkthrough Guide (Loom / Video)

When recording your demonstration walkthrough, follow this suggested 4-step structure:

1. **Architecture & Race Condition Prevention (1–2 min)**:
   - Explain why the old site sold 51 pairs (classic read-then-write race condition).
   - Show how row locks (`FOR UPDATE`) and SQL `CHECK` constraints guarantee zero overselling.
2. **Live Concurrency Demo (1–2 min)**:
   - On the web UI ([http://localhost:3000](http://localhost:3000)), click **"🚀 Simulate 30 Buyers at Once"**.
   - Show the breakdown: exactly 20 secured holds, 10 got `SOLD_OUT` and entered the waiting line.
   - Run `npm run check` in the terminal to prove the database invariant `0 + 20 + 0 = 20`.
3. **Queue Promotion & 5-Minute Timer (1–2 min)**:
   - Switch to `rush-shopper-1` to show the active hold countdown.
   - Switch to `rush-shopper-25` to show their place in line (`#5 in line`).
   - Explain direct hand-off: when a hold expires or is cancelled, the pair is passed directly to the next person in line with a fresh 5-minute timer.
4. **Payment Chaos & Idempotency (1–2 min)**:
   - Click **"Pay Now"** or **"Pay with Chaos (Dupe/Reorder)"** on an active hold.
   - Show the payment transitioning to `SUCCEEDED`, stock updated to `Paid = 1`, and purchase limit updated (`1 / 2`).
   - Show terminal logs demonstrating that duplicate webhooks are safely ignored as no-ops.

---

## 9. Cleanup

To shut down all services and containers when finished:
- Stop the running dev server in your terminal (`Ctrl + C`).
- Stop the PostgreSQL container:
  ```bash
  npm run db:down
  ```
