// src/hooks/useNetwork.js
//
// FULL REWRITE — fixes two critical bugs from the original:
//
//   BUG 1: The original file had `return` BEFORE `useEffect`, making the
//          polling loop and NetInfo listener dead code that never ran.
//
//   BUG 2: Mode detection used NetInfo.isInternetReachable which cannot
//          distinguish "no internet, but LAN server is reachable" (Mode 2)
//          from "server completely unreachable" (Mode 3).
//
// NEW DESIGN:
//   - Exports a `NetworkMode` enum: ONLINE | LAN_ONLY | DEEP_OFFLINE
//   - Mode is determined by probing GET /health directly, NOT by NetInfo
//   - Polling every CONNECTIVITY_POLL_INTERVAL_MS (15s default)
//   - AbortController enforces CONNECTIVITY_CHECK_TIMEOUT_MS (5s default)
//   - `probe()` is also exported so Settings screen can recheck on demand

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchHealth }                               from '../api/kb';
import { Config }                                    from '../config';

// ─────────────────────────────────────────────────────────────
// MODE ENUM
// Single source of truth — use this everywhere instead of booleans.
// ─────────────────────────────────────────────────────────────
export const NetworkMode = Object.freeze({
  ONLINE:       'ONLINE',       // Mode 1: server up + internet available
  LAN_ONLY:     'LAN_ONLY',     // Mode 2: server up, is_online=false
  DEEP_OFFLINE: 'DEEP_OFFLINE', // Mode 3: server completely unreachable
});

// ─────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────
export function useNetwork() {
  const [mode,        setMode]        = useState(NetworkMode.ONLINE);
  const [checking,    setChecking]    = useState(false);
  const [lastChecked, setLastChecked] = useState(null);

  const isMounted  = useRef(true);
  const timerRef   = useRef(null);

  /**
   * probe()
   *
   * Hits GET /health with a hard timeout.
   *   - Server unreachable (timeout / ECONNREFUSED) → DEEP_OFFLINE
   *   - Server responds + health.is_online === true  → ONLINE
   *   - Server responds + health.is_online === false → LAN_ONLY
   *
   * This is the ONLY place where mode is set. NetInfo is not used for
   * mode detection because isInternetReachable cannot distinguish
   * LAN-reachable (Mode 2) from fully offline (Mode 3).
   */
  const probe = useCallback(async () => {
    if (!isMounted.current) return;
    setChecking(true);

    const controller = new AbortController();
    const timeout    = setTimeout(
      () => controller.abort(),
      Config.CONNECTIVITY_CHECK_TIMEOUT_MS,
    );

    try {
      const health = await fetchHealth(controller.signal);
      clearTimeout(timeout);
      if (!isMounted.current) return;

      const next = health.is_online ? NetworkMode.ONLINE : NetworkMode.LAN_ONLY;
      setMode(next);
    } catch {
      // Abort (timeout) OR network error — either way the server is unreachable
      clearTimeout(timeout);
      if (isMounted.current) setMode(NetworkMode.DEEP_OFFLINE);
    } finally {
      if (isMounted.current) {
        setChecking(false);
        setLastChecked(new Date());
      }
    }
  }, []);

  useEffect(() => {
    // ── THIS IS NOW BEFORE ANY RETURN — bug 1 is fixed ──────────────
    isMounted.current = true;

    // Initial probe immediately on mount
    probe();

    // Then schedule a recurring poll
    const schedule = () => {
      timerRef.current = setTimeout(async () => {
        if (!isMounted.current) return;
        await probe();
        schedule(); // re-arm after each probe completes
      }, Config.CONNECTIVITY_POLL_INTERVAL_MS);
    };
    schedule();

    return () => {
      isMounted.current = false;
      clearTimeout(timerRef.current);
    };
  }, [probe]); // probe is stable (useCallback with no deps that change)

  return {
    mode,           // NetworkMode enum value — use this to drive all logic
    checking,       // true while a probe is in-flight (show spinner in Settings)
    lastChecked,    // Date | null — when the last probe finished
    probe,          // call manually (e.g. Settings "Recheck" button)
  };
}