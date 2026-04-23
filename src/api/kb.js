// src/api/kb.js
//
// CHANGE: fetchHealth() now accepts an explicit `baseUrl` parameter so
// useNetwork can probe arbitrary URLs (cloud and local) without going
// through the cached AsyncStorage lookup.
// The function still works with no arguments — falls back to getBaseUrl().

import { apiFetch, getBaseUrl } from './client';

/**
 * Health probe — used by useNetwork to determine the current network mode.
 *
 * @param {AbortSignal|null} signal  — optional abort signal for timeout control
 * @param {string}           baseUrl — URL to probe (defaults to stored server URL)
 */
export async function fetchHealth(signal, baseUrl) {
  const base = baseUrl || await getBaseUrl();
  const res  = await fetch(`${base}/health`, {
    signal,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json(); // { status, is_online, groq_configured }
}

export const fetchStats     = (activeUrl = '') => apiFetch('/stats',     activeUrl).then(r => r.json());
export const fetchDocuments = (activeUrl = '') => apiFetch('/documents', activeUrl).then(r => r.json());