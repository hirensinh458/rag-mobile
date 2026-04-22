import { useState, useEffect, useRef } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { fetchHealth } from '../api/kb';
import { Config } from '../config';

export function useNetwork() {
    const [isOnline, setIsOnline] = useState(true);
    const [serverReachable, setServerReachable] = useState(true);
    const timerRef = useRef(null);

    // In src/hooks/useNetwork.js — update checkServer():
    const checkServer = async () => {
        try {
            const health = await fetchHealth();
            setServerReachable(true);
            // health.is_online = false means server up but no internet (at sea)
            setServerHasInternet(health.is_online ?? true);
            return health;
        } catch {
            setServerReachable(false);
            setServerHasInternet(false);
            return null;
        }
    };

    // Add to return:
    return { isOnline, serverReachable, serverHasInternet, checkServer };

    useEffect(() => {
        // Device network state (WiFi / cellular / none)
        const unsubscribe = NetInfo.addEventListener(state => {
            setIsOnline(state.isConnected && state.isInternetReachable !== false);
        });

        // Poll server reachability (every SYNC_INTERVAL / 10)
        const poll = async () => {
            await checkServer();
            timerRef.current = setTimeout(poll, Config.SYNC_INTERVAL_MS / 10);
        };
        poll();

        return () => {
            unsubscribe();
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    return { isOnline, serverReachable, checkServer };
}