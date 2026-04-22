// src/api/kb.js
//
// CHANGE: fetchHealth() now accepts an AbortSignal so useNetwork can enforce
// a short timeout independently of apiFetch's generic 30s timeout.
// Uses a raw fetch() call (not apiFetch) so the signal is passed cleanly
// without fighting the inner AbortController in apiFetch.

import { apiFetch, getBaseUrl } from './client';

/**
 * Health probe — used by useNetwork to determine the current network mode.
 *
 * Accepts an AbortSignal so the caller can enforce a short timeout (e.g. 5s).
 * Returns the parsed JSON body, or throws on timeout/network error.
 */
export async function fetchHealth(signal) {
  const base = await getBaseUrl();
  const res  = await fetch(`${base}/health`, {
    signal,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json(); // { status, is_online, groq_configured }
}

export const fetchStats     = () => apiFetch('/stats').then(r => r.json());
export const fetchDocuments = () => apiFetch('/documents').then(r => r.json());