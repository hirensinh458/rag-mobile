// src/api/client.js
//
// CHANGE: getBaseUrl() now reads the user-saved server URL from AsyncStorage
// first, falling back to Config.API_BASE_URL (env variable / default emulator IP).
// Previously, the SettingsScreen saved the URL to AsyncStorage but nothing
// ever read it back — it was silently ignored.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Config }   from '../config';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name   = 'ApiError';
    this.status = status;
  }
}

// Reads server URL from AsyncStorage. Cached per-session so we don't hit
// storage on every request. Call invalidateUrlCache() after the user saves
// new settings.
let _cachedUrl = null;

export async function getBaseUrl() {
  if (_cachedUrl) return _cachedUrl;
  const saved = await AsyncStorage.getItem('server_url');
  _cachedUrl  = (saved && saved.trim()) ? saved.trim() : Config.API_BASE_URL;
  return _cachedUrl;
}

// Call this from SettingsScreen after saving a new URL so the next
// request picks it up immediately.
export function invalidateUrlCache() {
  _cachedUrl = null;
}

export async function apiFetch(path, options = {}) {
  const base       = await getBaseUrl();
  const url        = `${base}${path}`;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      ...options,
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(text || `HTTP ${res.status}`, res.status);
    }

    return res;
  } finally {
    clearTimeout(timeout);
  }
}