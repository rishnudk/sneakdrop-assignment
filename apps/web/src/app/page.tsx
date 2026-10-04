'use client';

import React, { useState, useEffect } from 'react';
import { useDropStatus } from './useDropStatus';

export default function DropPage() {
  const [userId, setUserId] = useState<string>('buyer-1');
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const showMsg = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setActionMessage({ text, type });
  };

  // 1. Buy action
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
        showMsg('🎉 Pair successfully held for you! You have 5 minutes to complete payment.', 'success');
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

  // 2. Pay action
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
        showMsg('💳 Payment initiated! Waiting for fake gateway confirmation webhook...', 'info');
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

  // 3. Join waitlist action
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

  // 4. Leave waitlist action
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

  const isHolding = Boolean(status?.me.hold && status.me.hold.status === 'HELD');
  const isWaiting = Boolean(status?.me.waitlist);
  const availableStock = status?.stock.available ?? 0;
  const isSoldOut = availableStock === 0;

  return (
    <main style={{ maxWidth: '720px', margin: '40px auto', padding: '0 20px' }}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid #24242d', paddingBottom: '20px', marginBottom: '30px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h1 style={{ margin: '0 0 6px 0', fontSize: '28px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              👟 Air Velocity Drop #1
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
                padding: '4px 10px',
                borderRadius: '20px',
                backgroundColor: isSoldOut ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
                color: isSoldOut ? '#ef4444' : '#22c55e',
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: isSoldOut ? '#ef4444' : '#22c55e',
                }}
              />
              {isSoldOut ? 'STOCK EXHAUSTED' : 'SALE LIVE'}
            </span>
          </div>
        </div>
      </header>

      {/* User Switcher for Interview / Testing */}
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
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: '#8e8e9f' }}>Quick switch:</span>
            {['buyer-1', 'buyer-2', 'buyer-3', 'waiter-x'].map((u) => (
              <button
                key={u}
                onClick={() => handleUserChange(u)}
                style={{
                  background: userId === u ? '#4f46e5' : '#242430',
                  color: '#fff',
                  border: 'none',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </section>

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
          <div style={{ fontSize: '12px', color: '#8e8e9f', fontWeight: 600 }}>AVAILABLE TO BUY</div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: availableStock > 0 ? '#22c55e' : '#ef4444', marginTop: '4px' }}>
            {availableStock}
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>Instant hold claim</div>
        </div>

        <div style={{ background: '#131318', border: '1px solid #23232c', padding: '16px', borderRadius: '10px' }}>
          <div style={{ fontSize: '12px', color: '#8e8e9f', fontWeight: 600 }}>IN CHECKOUT (HELD)</div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: '#f59e0b', marginTop: '4px' }}>
            {status?.stock.held ?? 0}
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>5-minute timer ticking</div>
        </div>

        <div style={{ background: '#131318', border: '1px solid #23232c', padding: '16px', borderRadius: '10px' }}>
          <div style={{ fontSize: '12px', color: '#8e8e9f', fontWeight: 600 }}>COMPLETED (PAID)</div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: '#3b82f6', marginTop: '4px' }}>
            {status?.stock.paid ?? 0}
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>Finalized sales</div>
        </div>

        <div style={{ background: '#131318', border: '1px solid #23232c', padding: '16px', borderRadius: '10px' }}>
          <div style={{ fontSize: '12px', color: '#8e8e9f', fontWeight: 600 }}>YOUR PURCHASES</div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: '#a855f7', marginTop: '4px' }}>
            {status?.me.purchased ?? 0} / 2
          </div>
          <div style={{ fontSize: '11px', color: '#68687a', marginTop: '2px' }}>Max 2 pairs per user</div>
        </div>
      </section>

      {/* Action Notification Alert */}
      {actionMessage && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '14px',
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
          {actionMessage.text}
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
            Complete your payment before time expires, or this pair will be given to the next person in line.
          </p>

          {status.me.hold.payment?.status === 'PROCESSING' ? (
            <div style={{ color: '#f59e0b', fontWeight: 600, fontSize: '14px' }}>
              ⏳ Payment is currently processing... awaiting gateway webhook.
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', flexWrap: 'wrap' }}>
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
            As soon as an active hold runs out, this pair will be automatically promoted to you!
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

      {/* Primary Action Button (Buy or Join Waitlist) */}
      {!isHolding && !isWaiting && (
        <section style={{ textAlign: 'center', margin: '30px 0' }}>
          {availableStock > 0 ? (
            <button
              onClick={handleBuy}
              disabled={submitting || (status?.me.purchased ?? 0) >= 2}
              style={{
                width: '100%',
                maxWidth: '400px',
                background: (status?.me.purchased ?? 0) >= 2 ? '#333' : '#4f46e5',
                color: '#fff',
                fontSize: '18px',
                fontWeight: 700,
                padding: '16px 24px',
                borderRadius: '10px',
                border: 'none',
                cursor: (status?.me.purchased ?? 0) >= 2 || submitting ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 20px rgba(79, 70, 229, 0.4)',
              }}
            >
              {submitting
                ? 'Reserving...'
                : (status?.me.purchased ?? 0) >= 2
                ? 'Purchase Limit Reached (2/2)'
                : 'BUY NOW ($180.00)'}
            </button>
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
                {submitting ? 'Joining...' : 'JOIN WAITING LINE'}
              </button>
            </div>
          )}
        </section>
      )}

      {/* System Invariant Footer */}
      <footer
        style={{
          marginTop: '60px',
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
        <div>Authoritative server clock: {status?.serverNow ? new Date(status.serverNow).toLocaleTimeString() : '...'}</div>
      </footer>
    </main>
  );
}
