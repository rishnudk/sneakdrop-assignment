'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface DropStatus {
  serverNow: string;
  stock: {
    total: number;
    available: number;
    held: number;
    paid: number;
  };
  me: {
    userId: string;
    purchased: number;
    hold: {
      id: string;
      status: string;
      source: string;
      expiresAt: string;
      secondsLeft: number;
      payment: {
        id: string;
        status: string;
        providerRef: string;
        refundNeeded: boolean;
      } | null;
    } | null;
    waitlist: {
      position: number;
      ahead: number;
      size: number;
    } | null;
  };
}

export function useDropStatus(userId: string) {
  const [status, setStatus] = useState<DropStatus | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const serverOffsetRef = useRef<number>(0);

  const fetchStatus = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch('/api/status', {
        headers: {
          'x-user-id': userId,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch status: ${res.status}`);
      }

      const data: DropStatus = await res.json();
      setStatus(data);
      setError(null);

      // Compute server clock offset to prevent browser clock drift
      const serverTime = new Date(data.serverNow).getTime();
      serverOffsetRef.current = serverTime - Date.now();

      if (data.me.hold && data.me.hold.status === 'HELD') {
        const expiresAtMs = new Date(data.me.hold.expiresAt).getTime();
        const adjustedNow = Date.now() + serverOffsetRef.current;
        const diff = Math.max(0, Math.floor((expiresAtMs - adjustedNow) / 1000));
        setSecondsRemaining(diff);
      } else {
        setSecondsRemaining(null);
      }
    } catch (err: any) {
      setError(err.message || 'Error connecting to server');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Initial fetch and 1-second polling
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 1500);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Local 1-second ticking countdown for fluid UI
  useEffect(() => {
    if (secondsRemaining === null || secondsRemaining <= 0) return;

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev === null || prev <= 1) {
          fetchStatus(); // Re-sync with server when countdown expires
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [secondsRemaining, fetchStatus]);

  const formattedCountdown =
    secondsRemaining !== null
      ? `${String(Math.floor(secondsRemaining / 60)).padStart(2, '0')}:${String(
          secondsRemaining % 60
        ).padStart(2, '0')}`
      : null;

  return {
    status,
    loading,
    error,
    secondsRemaining,
    formattedCountdown,
    refresh: fetchStatus,
  };
}
