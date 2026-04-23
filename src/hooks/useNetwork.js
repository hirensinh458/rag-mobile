// src/hooks/useNetwork.js
//
// CHANGE: Full rewrite for three-URL network architecture.
//   - Exports `NetworkMode` constant (was missing — caused silent bug in useOfflineSearch)
//   - Sequential probe: cloud URL first → local URL fallback → deep_offline
//   - Returns `activeUrl` (the URL currently working) so all API calls use the right server
//   - Probe interval reduced to 15s (was 30s) for faster mode transitions
//   - Each health probe has a 4s timeout (was 5s)

import { useState, useEffect, useRef, useCallback } from 'react';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Config } from '../config';

// Exported so useOfflineSearch (and any other hook) can import it
export const NetworkMode = {
  FULL_ONLINE:   'full_online',
  INTRANET_ONLY: 'intranet_only',
  DEEP_OFFLINE:  'deep_offline',
};

const PROBE_INTERVAL_MS = 15_000;  // probe every 15s
const PROBE_TIMEOUT_MS  = 4_000;   // 4s per health check

/**
 * Probe a single server URL.
 * Returns { reachable, isOnline } — never throws.
 */
async function probeHealth(baseUrl) {
  if (!baseUrl) return { reachable: false, isOnline: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res  = await fetch(`${baseUrl}/health`, {
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    return { reachable: true, isOnline: data.is_online ?? false };
  } catch {
    return { reachable: false, isOnline: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Three-state network hook.
 *
 * Reads `cloud_url` and `local_url` from AsyncStorage (set in SettingsScreen).
 * Probes cloud first, falls back to local.
 *
 * Returns:
 *   mode         — 'full_online' | 'intranet_only' | 'deep_offline'
 *   activeUrl    — the URL currently being used for API calls (empty string if deep_offline)
 *   cloudStatus  — { reachable, isOnline } or null
 *   localStatus  — { reachable, isOnline } or null
 *   serverReachable   — convenience bool for NetworkBanner
 *   serverHasInternet — convenience bool for NetworkBanner
 *   probe        — call to force an immediate re-probe
 */
export function useNetwork() {
  const [mode,         setMode]         = useState(NetworkMode.FULL_ONLINE);
  const [activeUrl,    setActiveUrl]    = useState('');
  const [cloudStatus,  setCloudStatus]  = useState(null);
  const [localStatus,  setLocalStatus]  = useState(null);
  const timerRef = useRef(null);

  const probe = useCallback(async () => {
    // Always load URLs fresh — user may have updated settings since last probe
    const cloudUrl = (await AsyncStorage.getItem('cloud_url') || '').trim();
    const localUrl = (await AsyncStorage.getItem('local_url') || '').trim() || Config.API_BASE_URL;

    // 1. Try cloud
    let cloudResult = { reachable: false, isOnline: false };
    if (cloudUrl) {
      cloudResult = await probeHealth(cloudUrl);
      setCloudStatus(cloudResult);
    }

    // 2. Always try local
    const localResult = await probeHealth(localUrl);
    setLocalStatus(localResult);

    // 3. Derive mode — cloud takes priority over local
    if (cloudResult.reachable && cloudResult.isOnline) {
      setMode(NetworkMode.FULL_ONLINE);
      setActiveUrl(cloudUrl);
    } else if (cloudResult.reachable && !cloudResult.isOnline) {
      // Cloud server up but no internet — use it for retrieval (Mode 2)
      setMode(NetworkMode.INTRANET_ONLY);
      setActiveUrl(cloudUrl);
    } else if (localResult.reachable && localResult.isOnline) {
      // Cloud down, local has internet
      setMode(NetworkMode.FULL_ONLINE);
      setActiveUrl(localUrl);
    } else if (localResult.reachable) {
      // Local up, no internet — Mode 2 via local server
      setMode(NetworkMode.INTRANET_ONLY);
      setActiveUrl(localUrl);
    } else {
      // Nothing reachable — Mode 3
      setMode(NetworkMode.DEEP_OFFLINE);
      setActiveUrl('');
    }
  }, []);

  useEffect(() => {
    // Device connectivity listener (for UI state only — probe does the real check)
    const unsubscribe = NetInfo.addEventListener(() => {
      // Just trigger a fresh probe when device network state changes
      probe();
    });

    // Initial probe + recursive schedule
    let cancelled = false;
    const schedule = () => {
      timerRef.current = setTimeout(() => {
        if (!cancelled) probe().then(schedule);
      }, PROBE_INTERVAL_MS);
    };
    probe().then(schedule);

    return () => {
      cancelled = true;
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [probe]);

  // Convenience booleans for NetworkBanner (keeps its existing API unchanged)
  const serverReachable   = mode !== NetworkMode.DEEP_OFFLINE;
  const serverHasInternet = mode === NetworkMode.FULL_ONLINE;

  return {
    mode,
    activeUrl,
    cloudStatus,
    localStatus,
    serverReachable,
    serverHasInternet,
    probe,
  };
}