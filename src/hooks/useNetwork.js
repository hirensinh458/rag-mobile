// src/hooks/useNetwork.js
import { useState, useEffect, useRef, useCallback } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { fetchHealth } from '../api/kb';
import { Config } from '../config';

/**
 * Three-state network hook.
 *
 * mode values:
 *   'full_online'   — server reachable + server has internet → use Groq LLM
 *   'intranet_only' — server reachable but no internet       → retrieval only (/chat/offline)
 *   'deep_offline'  — server unreachable                     → local SQLite FTS
 */
export function useNetwork() {
  const [isOnline,          setIsOnline]          = useState(true);
  const [serverReachable,   setServerReachable]   = useState(false);
  const [serverHasInternet, setServerHasInternet] = useState(false);
  const timerRef = useRef(null);

  // Derived mode — single string consumed by useChat and ChatScreen
  const mode =
    !serverReachable       ? 'deep_offline'   :
    serverHasInternet      ? 'full_online'    :
                             'intranet_only';

  const checkServer = useCallback(async () => {
    try {
      const health = await fetchHealth();
      setServerReachable(true);
      // health.is_online = server's own internet check (can it reach 8.8.8.8?)
      setServerHasInternet(health.is_online ?? true);
      return health;
    } catch {
      setServerReachable(false);
      setServerHasInternet(false);
      return null;
    }
  }, []);

  useEffect(() => {
    // 1. Device network state (WiFi / cellular / none)
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOnline(!!(state.isConnected && state.isInternetReachable !== false));
    });

    // 2. Recursive poll for server health
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await checkServer();
      if (!cancelled) {
        timerRef.current = setTimeout(poll, Config.SYNC_INTERVAL_MS / 10);
      }
    };
    poll();

    return () => {
      cancelled = true;
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [checkServer]);

  return { isOnline, serverReachable, serverHasInternet, mode, checkServer };
}