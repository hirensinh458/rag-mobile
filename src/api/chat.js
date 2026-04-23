// src/api/chat.js
//
// CHANGE: Both streamChat() and fetchOfflineResponse() now accept an
// `activeUrl` parameter so the URL resolved by useNetwork.activeUrl is
// used directly instead of the cached AsyncStorage value.
// clearSession() also accepts activeUrl for consistency.

import { streamSSE } from './sse';
import { apiFetch }  from './client';

/**
 * Online — XHR-based SSE streaming.
 * Returns an abort function so useChat can cancel mid-stream.
 *
 * @param {string}   question
 * @param {string}   sessionId
 * @param {string|null} pinnedFile
 * @param {object}   callbacks  — { onEvent, onDone, onError }
 * @param {string}   activeUrl  — base URL from useNetwork (e.g. 'http://192.168.1.X:8001')
 */
export function streamChat(question, sessionId = 'default', pinnedFile = null, callbacks = {}, activeUrl = '') {
  const body = { question, session_id: sessionId };
  if (pinnedFile) body.pinned_file = pinnedFile;

  const xhr = streamSSE(
    '/chat/stream',
    body,
    callbacks.onEvent,
    callbacks.onDone,
    callbacks.onError,
    activeUrl,   // passed to streamSSE as baseUrl
  );

  return () => xhr?.abort(); // returns cancel fn
}

/**
 * Offline — plain JSON response from server (Mode 2).
 *
 * @param {string}      question
 * @param {string|null} pinnedFile
 * @param {string}      activeUrl  — base URL from useNetwork
 */
export async function fetchOfflineResponse(question, pinnedFile = null, activeUrl = '') {
  const body = { question };
  if (pinnedFile) body.pinned_file = pinnedFile;

  const res = await apiFetch('/chat/offline', activeUrl, {
    method: 'POST',
    body:   JSON.stringify(body),
  });
  return res.json();
}

/**
 * Clear the server-side session history.
 *
 * @param {string} sessionId
 * @param {string} activeUrl  — base URL from useNetwork
 */
export async function clearSession(sessionId = 'default', activeUrl = '') {
  await apiFetch('/chat/clear', activeUrl, {
    method: 'POST',
    body:   JSON.stringify({ session_id: sessionId }),
  });
}