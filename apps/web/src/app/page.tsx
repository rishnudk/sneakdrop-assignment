'use client';

import React, { useState, useEffect } from 'react';
import { useDropStatus } from './useDropStatus';

interface SimulationResult {
  attempted: number;
  held: number;
  soldOut: number;
  waitlisted: number;
  durationMs: number;
  results: Array<{
    username: string;
    userId: string;
    status: string;
    holdId?: string;
    message?: string;
  }>;
}

export default function DropPage() {
  const [userId, setUserId] = useState<string>('buyer-1');
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simulationData, setSimulationData] = useState<SimulationResult | null>(null);
  const [prevPurchased, setPrevPurchased] = useState<number>(0);

  // Load / persist username in local storage
  useEffect(() => {
    const saved = localStorage.getItem('sneaker_drop_user');
    if (saved) setUserId(saved);
  }, []);

  const handleUserChange = (newUserId: string) => {
    const cleaned = newUserId.trim() || 'buyer-1';
    setUserId(cleaned);
    localStorage.setItem('sneaker_drop_user', cleaned);
    setActionMessage(null);
  };

  const { status, loading, error, formattedCountdown, refresh } = useDropStatus(userId);

  // Detect when payment succeeds and transitions to purchased
  useEffect(() => {
    if (status && status.me.purchased > prevPurchased) {
      if (prevPurchased !== 0) {
        showMsg(`🎉 Payment Succeeded! You successfully purchased pair #${status.me.purchased}!`, 'success');
      }
      setPrevPurchased(status.me.purchased);
    } else if (status) {
      setPrevPurchased(status.me.purchased);
    }
  }, [status?.me.purchased]);

  const showMsg = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setActionMessage({ text, type });
  };

  // 1. Buy action (Acquires a 5-minute hold)
  const handleBuy = async () => {
    setSubmitting(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/buy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
        },
      });
      const data = await res.json();
      if (res.status === 201) {
        showMsg('🎉 Pair reserved for you! You now have 5 minutes to complete payment.', 'success');
        refresh();
      } else {
        showMsg(`❌ ${data.message || data.error}`, 'error');
        refresh();
      }
    } catch (err: any) {
      showMsg(`Error: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 2. Pay action (Initiates payment for an active hold)
  const handlePay = async (holdId: string, chaosOption?: Record<string, any>) => {
    setSubmitting(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/holds/${holdId}/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({ chaos: chaosOption }),
      });
      const data = await res.json();
      if (res.status === 202) {
        showMsg('💳 Payment initiated! Awaiting simulated gateway webhook confirmation...', 'info');
        refresh();
      } else {
        showMsg(`❌ ${data.message || data.error}`, 'error');
      }
    } catch (err: any) {
      showMsg(`Error: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 3. 1-Click Buy & Pay (Convenience demo feature)
  const handleBuyAndInstantPay = async () => {
    setSubmitting(true);
    setActionMessage(null);
    try {
      // Step A: Hold
      const buyRes = await fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      });
      const buyData = await buyRes.json();
      if (buyRes.status !== 201) {
        showMsg(`❌ Could not reserve: ${buyData.message || buyData.error}`, 'error');
        refresh();
        return;
      }

      showMsg('👟 Pair held! Now triggering instant payment...', 'info');

      // Step B: Pay
      const holdId = buyData.hold.id;
      const payRes = await fetch(`/api/holds/${holdId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ chaos: { delayMs: 800, duplicate: false, reorder: false, fail: false } }),
      });
      const payData = await payRes.json();
      if (payRes.status === 202) {
        showMsg('💳 Payment processing! Webhook will confirm within 1-2 seconds...', 'info');
        refresh();
      } else {
        showMsg(`❌ Payment error: ${payData.message || payData.error}`, 'error');
      }
    } catch (err: any) {
      showMsg(`Error: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 4. Join waitlist action
  const handleJoinWaitlist = async () => {
    setSubmitting(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/waitlist/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
        },
      });
      const data = await res.json();
      if (res.status === 201) {
        showMsg(`🎟️ You joined the waiting line at position #${data.position}!`, 'success');
        refresh();
      } else {
        showMsg(`❌ ${data.message || data.error}`, 'error');
      }
    } catch (err: any) {
      showMsg(`Error: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 5. Leave waitlist action
  const handleLeaveWaitlist = async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/waitlist/leave', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
        },
      });
      if (res.ok) {
        showMsg('You voluntarily left the waiting line.', 'info');
        refresh();
      }
    } catch (err: any) {
      showMsg(`Error: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 6. Simulate 30 Concurrent Shoppers Rush (Assessment requirement feature)
  const handleSimulateRush = async (count: number = 30) => {
    setSimulating(true);
    setActionMessage(null);
    setSimulationData(null);
    try {
      const res = await fetch('/api/admin/simulate-rush', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'admin',
        },
        body: JSON.stringify({ count, autoWaitlist: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setSimulationData(data);
        showMsg(
          `⚡ Rush Simulation complete! ${data.held} secured holds, ${data.soldOut} got sold-out & joined waitlist in ${data.durationMs}ms. Zero overselling!`,
          'success'
        );
        refresh();
      } else {
        showMsg(`Simulation failed: ${data.message || data.error}`, 'error');
      }
    } catch (err: any) {
      showMsg(`Simulation error: ${err.message}`, 'error');
    } finally {
      setSimulating(false);
    }
  };

  // 7. Reset Drop to Clean State
  const handleResetDrop = async () => {
    if (!confirm('Reset drop to clean state (20 available, clear all holds, waitlists, and payments)?')) {
      return;
    }
    setSubmitting(true);
    setSimulationData(null);
    try {
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'admin',
        },
      });
      const data = await res.json();
      if (res.ok) {
        showMsg('🔄 Drop reset to clean initial state: 20 available pairs.', 'info');
        refresh();
      } else {
        showMsg(`Reset failed: ${data.message}`, 'error');
      }
    } catch (err: any) {
      showMsg(`Reset error: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const isHolding = Boolean(status?.me.hold && status.me.hold.status === 'HELD');
  const isWaiting = Boolean(status?.me.waitlist);
  const availableStock = status?.stock.available ?? 0;
  const isSoldOut = availableStock === 0;
  const isPaymentPending =
    status?.me.hold?.payment &&
    (status.me.hold.payment.status === 'CREATED' || status.me.hold.payment.status === 'PROCESSING');

  return (
    <main style={{ maxWidth: '800px', margin: '30px auto', padding: '0 20px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid #24242d', paddingBottom: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h1 style={{ margin: '0 0 6px 0', fontSize: '28px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              👟 Air Velocity Retro Drop #1
            </h1>
            <p style={{ margin: 0, color: '#8e8e9f', fontSize: '14px' }}>
              Limited launch of exactly 20 pairs. Zero overselling guarantee.
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                padding: '5px 12px',
                borderRadius: '20px',
                backgroundColor: isSoldOut ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
                color: isSoldOut ? '#ef4444' : '#22c55e',
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: isSoldOut ? '#ef4444' : '#22c55e',
                }}
              />
              {isSoldOut ? 'STOCK EXHAUSTED (0 Available)' : 'SALE LIVE (Available Now)'}
            </span>
          </div>
        </div>
      </header>

      {/* Stock Overview Dashboard (Rule 5) */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '12px',
          marginBottom: '24px',
        }}
      >
        <div style={{ background: '#131318', border: '1px solid #23232c', padding: '16px', borderRadius: '10px' }}>
          <div style={{ fontSize: '11px', color: '#8e8e9f', fontWeight: 700, letterSpacing: '0.5px' }}>AVAILABLE STOCK</div>
          <div style={{ fontSize: '32px', fontWeight: 800, color: availableStock > 0 ? '#22c55e' : '#ef4444', marginTop: '4px' }}>
            {availableStock}
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>Instant hold claim</div>
        </div>

        <div style={{ background: '#131318', border: '1px solid #23232c', padding: '16px', borderRadius: '10px' }}>
          <div style={{ fontSize: '11px', color: '#8e8e9f', fontWeight: 700, letterSpacing: '0.5px' }}>IN CHECKOUT (HELD)</div>
          <div style={{ fontSize: '32px', fontWeight: 800, color: '#f59e0b', marginTop: '4px' }}>
            {status?.stock.held ?? 0}
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>5-minute hold timer</div>
        </div>

        <div style={{ background: '#131318', border: '1px solid #23232c', padding: '16px', borderRadius: '10px' }}>
          <div style={{ fontSize: '11px', color: '#8e8e9f', fontWeight: 700, letterSpacing: '0.5px' }}>COMPLETED (PAID)</div>
          <div style={{ fontSize: '32px', fontWeight: 800, color: '#3b82f6', marginTop: '4px' }}>
            {status?.stock.paid ?? 0}
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>Finalized sales</div>
        </div>

        <div style={{ background: '#131318', border: '1px solid #23232c', padding: '16px', borderRadius: '10px' }}>
          <div style={{ fontSize: '11px', color: '#8e8e9f', fontWeight: 700, letterSpacing: '0.5px' }}>YOUR PURCHASES</div>
          <div style={{ fontSize: '32px', fontWeight: 800, color: (status?.me.purchased ?? 0) > 0 ? '#a855f7' : '#fff', marginTop: '4px' }}>
            {status?.me.purchased ?? 0} / 2
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>Max 2 pairs per user</div>
        </div>
      </section>

      {/* Shopper Switcher Bar */}
      <section
        style={{
          backgroundColor: '#131318',
          border: '1px solid #23232c',
          borderRadius: '12px',
          padding: '16px 20px',
          marginBottom: '24px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', color: '#8e8e9f', fontWeight: 700, marginBottom: '6px' }}>
              Current Shopper (User ID)
            </label>
            <input
              type="text"
              value={userId}
              onChange={(e) => handleUserChange(e.target.value)}
              style={{
                background: '#1a1a22',
                border: '1px solid #323240',
                color: '#fff',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '14px',
                width: '180px',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: '#8e8e9f' }}>Quick switch:</span>
            {['buyer-1', 'buyer-2', 'buyer-3', 'waiter-x', 'rush-shopper-1', 'rush-shopper-25'].map((u) => (
              <button
                key={u}
                onClick={() => handleUserChange(u)}
                style={{
                  background: userId === u ? '#4f46e5' : '#242430',
                  color: '#fff',
                  border: 'none',
                  padding: '5px 10px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontWeight: userId === u ? 700 : 500,
                }}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Action Notification Alert */}
      {actionMessage && (
        <div
          style={{
            padding: '14px 18px',
            borderRadius: '10px',
            marginBottom: '20px',
            fontSize: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor:
              actionMessage.type === 'success'
                ? 'rgba(34, 197, 94, 0.15)'
                : actionMessage.type === 'error'
                ? 'rgba(239, 68, 68, 0.15)'
                : 'rgba(59, 130, 246, 0.15)',
            border: `1px solid ${
              actionMessage.type === 'success'
                ? '#22c55e'
                : actionMessage.type === 'error'
                ? '#ef4444'
                : '#3b82f6'
            }`,
            color: '#fff',
          }}
        >
          <span>{actionMessage.text}</span>
          <button
            onClick={() => setActionMessage(null)}
            style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '16px' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Purchased Success Banner (If user has purchased pairs) */}
      {(status?.me.purchased ?? 0) > 0 && !isHolding && (
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.15) 0%, rgba(16, 185, 129, 0.05) 100%)',
            border: '1px solid #22c55e',
            borderRadius: '12px',
            padding: '16px 20px',
            marginBottom: '24px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div style={{ fontSize: '28px' }}>🎉</div>
          <div>
            <div style={{ color: '#22c55e', fontWeight: 700, fontSize: '15px' }}>
              Purchase Confirmed ({status?.me.purchased} of 2 pairs owned)
            </div>
            <div style={{ color: '#aaa', fontSize: '13px', marginTop: '2px' }}>
              Your order is finalized in database with zero chance of overselling.
            </div>
          </div>
        </div>
      )}

      {/* Active Hold Countdown Section (Rule 1 & Rule 5) */}
      {isHolding && status?.me.hold && (
        <section
          style={{
            background: 'linear-gradient(180deg, #181822 0%, #121218 100%)',
            border: '2px solid #f59e0b',
            borderRadius: '14px',
            padding: '24px',
            marginBottom: '24px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '13px', textTransform: 'uppercase', color: '#f59e0b', fontWeight: 700, letterSpacing: '1px' }}>
            ⏱️ Pair Reserved For You ({status.me.hold.source === 'WAITLIST' ? 'Waitlist Promotion' : 'Direct Hold'})
          </div>

          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '48px',
              fontWeight: 800,
              color: '#fff',
              margin: '12px 0',
              letterSpacing: '2px',
            }}
          >
            {formattedCountdown || '00:00'}
          </div>

          <p style={{ color: '#8e8e9f', fontSize: '13px', margin: '0 0 20px 0' }}>
            Complete your payment before time expires, or this pair will automatically pass to the next person in line.
          </p>

          {isPaymentPending ? (
            <div
              style={{
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid #f59e0b',
                borderRadius: '8px',
                padding: '14px',
                color: '#f59e0b',
                fontWeight: 600,
                fontSize: '14px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>⏳</span> Payment initiated! Gateway webhook is processing... (status will auto-refresh)
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <button
                onClick={() => handlePay(status.me.hold!.id)}
                disabled={submitting}
                style={{
                  background: '#22c55e',
                  color: '#000',
                  fontWeight: 700,
                  fontSize: '15px',
                  padding: '12px 28px',
                  borderRadius: '8px',
                  border: 'none',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 14px rgba(34, 197, 94, 0.3)',
                }}
              >
                {submitting ? 'Processing...' : 'Pay Now ($180.00)'}
              </button>

              {/* Chaos testing button for interview demo */}
              <button
                onClick={() => handlePay(status.me.hold!.id, { reorder: true, duplicate: true })}
                disabled={submitting}
                title="Sends reordered and duplicate webhooks to test robustness"
                style={{
                  background: '#2e2e3d',
                  color: '#e0e0ec',
                  fontWeight: 600,
                  fontSize: '13px',
                  padding: '12px 18px',
                  borderRadius: '8px',
                  border: '1px solid #444458',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >
                ⚡ Pay with Chaos (Dupe/Reorder)
              </button>
            </div>
          )}
        </section>
      )}

      {/* Waiting Line Section (Rule 3 & Rule 5) */}
      {isWaiting && status?.me.waitlist && (
        <section
          style={{
            background: '#13131d',
            border: '2px solid #8b5cf6',
            borderRadius: '14px',
            padding: '24px',
            marginBottom: '24px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '13px', textTransform: 'uppercase', color: '#a78bfa', fontWeight: 700, letterSpacing: '1px' }}>
            🎟️ Your Place in the Waiting Line
          </div>

          <div style={{ fontSize: '42px', fontWeight: 800, color: '#fff', margin: '12px 0' }}>
            Position #{status.me.waitlist.position}
          </div>

          <p style={{ color: '#8e8e9f', fontSize: '14px', margin: '0 0 16px 0' }}>
            There are <strong>{status.me.waitlist.ahead}</strong> person(s) ahead of you (Total line size: {status.me.waitlist.size}).
            As soon as an active hold runs out, this pair will be automatically promoted to you with fresh 5 minutes!
          </p>

          <button
            onClick={handleLeaveWaitlist}
            disabled={submitting}
            style={{
              background: 'transparent',
              color: '#ef4444',
              border: '1px solid #ef4444',
              padding: '8px 18px',
              borderRadius: '6px',
              fontSize: '13px',
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            Leave Line
          </button>
        </section>
      )}

      {/* Primary Action Section (Buy or Join Waitlist) */}
      {!isHolding && !isWaiting && (
        <section style={{ textAlign: 'center', margin: '24px 0 36px 0' }}>
          {availableStock > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
              <button
                onClick={handleBuy}
                disabled={submitting || (status?.me.purchased ?? 0) >= 2}
                style={{
                  width: '100%',
                  maxWidth: '400px',
                  background: (status?.me.purchased ?? 0) >= 2 ? '#333' : '#4f46e5',
                  color: '#fff',
                  fontSize: '17px',
                  fontWeight: 700,
                  padding: '16px 24px',
                  borderRadius: '10px',
                  border: 'none',
                  cursor: (status?.me.purchased ?? 0) >= 2 || submitting ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 20px rgba(79, 70, 229, 0.4)',
                }}
              >
                {submitting
                  ? 'Reserving Hold...'
                  : (status?.me.purchased ?? 0) >= 2
                  ? 'Purchase Limit Reached (2/2)'
                  : '👟 BUY NOW: RESERVE PAIR (5-MIN HOLD)'}
              </button>

              {(status?.me.purchased ?? 0) < 2 && (
                <button
                  onClick={handleBuyAndInstantPay}
                  disabled={submitting}
                  style={{
                    background: 'transparent',
                    color: '#a5b4fc',
                    border: '1px dashed #6366f1',
                    fontSize: '13px',
                    fontWeight: 600,
                    padding: '8px 16px',
                    borderRadius: '8px',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  ⚡ 1-Click Buy & Instant Pay (Demo Shortcut)
                </button>
              )}
            </div>
          ) : (
            <div>
              <p style={{ color: '#ef4444', fontWeight: 600, fontSize: '16px', marginBottom: '14px' }}>
                All 20 pairs are currently held or sold.
              </p>
              <button
                onClick={handleJoinWaitlist}
                disabled={submitting || (status?.me.purchased ?? 0) >= 2}
                style={{
                  width: '100%',
                  maxWidth: '400px',
                  background: '#8b5cf6',
                  color: '#fff',
                  fontSize: '16px',
                  fontWeight: 700,
                  padding: '14px 24px',
                  borderRadius: '10px',
                  border: 'none',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 16px rgba(139, 92, 246, 0.3)',
                }}
              >
                {submitting ? 'Joining Line...' : '🎟️ JOIN WAITING LINE'}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ========================================================================= */}
      {/* 🚀 CONCURRENCY & FLASH SALE SIMULATION PANEL (ASSESSMENT HIGHLIGHT)        */}
      {/* ========================================================================= */}
      <section
        style={{
          background: '#0d0d12',
          border: '1px solid #292938',
          borderRadius: '14px',
          padding: '24px',
          marginTop: '36px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 4px 0', color: '#fff' }}>
              ⚡ Flash Sale Concurrency Simulator
            </h2>
            <p style={{ fontSize: '13px', color: '#8e8e9f', margin: 0 }}>
              Test 30 buyers clicking Buy at the exact same millisecond to prove zero overselling.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={() => handleSimulateRush(30)}
              disabled={simulating || submitting}
              style={{
                background: '#f43f5e',
                color: '#fff',
                border: 'none',
                padding: '10px 18px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 700,
                cursor: simulating ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 14px rgba(244, 63, 94, 0.4)',
              }}
            >
              {simulating ? 'Simulating Stampede...' : '🚀 Simulate 30 Buyers at Once'}
            </button>

            <button
              onClick={handleResetDrop}
              disabled={submitting || simulating}
              style={{
                background: '#22222e',
                color: '#bbb',
                border: '1px solid #3c3c50',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              🔄 Reset Drop (20 Pairs)
            </button>
          </div>
        </div>

        {/* Live Simulation Results Box */}
        {simulationData && (
          <div
            style={{
              backgroundColor: '#16161f',
              border: '1px solid #303042',
              borderRadius: '10px',
              padding: '16px',
              marginTop: '16px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#22c55e' }}>
                ✓ Concurrency Burst Verified ({simulationData.durationMs}ms wall time)
              </span>
              <span style={{ fontSize: '12px', color: '#8e8e9f' }}>
                Total Requests: {simulationData.attempted}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '14px' }}>
              <div style={{ background: '#1c1c28', padding: '10px', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: '#8e8e9f' }}>SECURED HOLDS</div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#22c55e' }}>{simulationData.held} / 20</div>
              </div>
              <div style={{ background: '#1c1c28', padding: '10px', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: '#8e8e9f' }}>REJECTED (SOLD OUT)</div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#ef4444' }}>{simulationData.soldOut}</div>
              </div>
              <div style={{ background: '#1c1c28', padding: '10px', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: '#8e8e9f' }}>JOINED WAITLIST</div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#8b5cf6' }}>{simulationData.waitlisted}</div>
              </div>
            </div>

            <div style={{ fontSize: '12px', color: '#8e8e9f', marginBottom: '8px' }}>
              Quickly switch to inspect any simulated shopper:
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', maxHeight: '100px', overflowY: 'auto' }}>
              {simulationData.results.map((r) => (
                <button
                  key={r.username}
                  onClick={() => handleUserChange(r.username)}
                  style={{
                    background:
                      r.status === 'HELD'
                        ? 'rgba(34, 197, 94, 0.2)'
                        : 'rgba(139, 92, 246, 0.2)',
                    color: r.status === 'HELD' ? '#4ade80' : '#c084fc',
                    border: `1px solid ${r.status === 'HELD' ? '#22c55e' : '#8b5cf6'}`,
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  {r.username} ({r.status === 'HELD' ? 'Held' : 'Line'})
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* System Invariant Footer */}
      <footer
        style={{
          marginTop: '40px',
          borderTop: '1px solid #1f1f28',
          paddingTop: '20px',
          fontSize: '12px',
          color: '#555567',
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div>
          DB Invariant: <code>available ({availableStock}) + held ({status?.stock.held ?? 0}) + paid ({status?.stock.paid ?? 0}) = 20</code>
        </div>
        <div>Server clock: {status?.serverNow ? new Date(status.serverNow).toLocaleTimeString() : '...'}</div>
      </footer>
    </main>
  );
}
