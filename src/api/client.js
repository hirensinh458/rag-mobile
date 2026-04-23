// src/api/client.js
//
// CHANGE: apiFetch() now accepts an optional `activeUrl` as the second argument.
// When provided it is used directly, bypassing the AsyncStorage lookup.
// This lets useChat (and other callers) thread the URL from useNetwork.activeUrl
// without re-reading storage on every request.
//
// The old signature apiFetch(path, options) still works — if the second arg
// is a plain object (options) the legacy behaviour is preserved.

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
  // Prefer local_url (set by SettingsScreen new fields); fall back to legacy server_url
  const local  = await AsyncStorage.getItem('local_url');
  const legacy = await AsyncStorage.getItem('server_url');
  _cachedUrl = (local && local.trim())
    ? local.trim()
    : (legacy && legacy.trim())
      ? legacy.trim()
      : Config.API_BASE_URL;
  return _cachedUrl;
}

// Call this from SettingsScreen after saving a new URL so the next
// request picks it up immediately.
export function invalidateUrlCache() {
  _cachedUrl = null;
}

/**
 * apiFetch(path, activeUrl?, options?)
 *
 * Overloads:
 *   apiFetch('/chat/offline', options)                  — legacy, reads base from storage
 *   apiFetch('/chat/offline', activeUrl, options)       — new, uses activeUrl directly
 *   apiFetch('/chat/offline', activeUrl)                — new, no extra options
 */
export async function apiFetch(path, activeUrlOrOptions, options = {}) {
  let base;
  let opts;

  if (typeof activeUrlOrOptions === 'string') {
    // New signature: second arg is the active URL
    base = activeUrlOrOptions || await getBaseUrl();
    opts = options;
  } else {
    // Legacy signature: second arg is the options object
    base = await getBaseUrl();
    opts = activeUrlOrOptions || {};
  }

  const url        = `${base}${path}`;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      ...opts,
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
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