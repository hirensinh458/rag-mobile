// src/hooks/useChat.js  — P4 + parent_id-DEDUP
//
// CHANGES FROM PREVIOUS VERSION:
//   - Mode 3 deep_offline now deduplicates results on parent_id before display,
//     matching the dedup logic in ChainResponse.get_citations() (online mode).
//   - Dedup key = parent_id if non-empty, else source|page (same fallback).
//   - Only the highest-scoring child per parent is kept; stops at 5 unique parents.
//   - localSearch() still fetches 10 candidates to give the dedup enough material.
//   - All other modes and logging remain unchanged.

import { useState, useCallback, useRef } from 'react';
import { streamChat, fetchOfflineResponse, clearSession } from '../api/chat';
import { localSearch } from './useOfflineSearch';  // P4: hybrid search
import { createLogger } from '../utils/logger';

const log = createLogger('useChat');

/**
 * @param {string} activeUrl — the currently working server URL from useNetwork.
 *                             Empty string when deep_offline.
 */
export function useChat(activeUrl = '') {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState('');
  const cancelRef = useRef(null);

  log.debug('useChat() render — activeUrl:', activeUrl || '(none)', '| streaming:', streaming);

  /**
   * send(question, mode, pinnedFile)
   *
   * Mode 1 full_online   — XHR SSE stream to /chat/stream (Groq LLM)
   * Mode 2 intranet_only — POST /chat/offline (server-side retrieval)
   * Mode 3 deep_offline  — local hybrid search → dedup → display
   */
  const send = useCallback(async (question, mode = 'full_online', pinnedFile = null) => {
    log.info('send() CALLED', {
      question: question.slice(0, 120),
      mode,
      pinnedFile: pinnedFile || '(none)',
      activeUrl: activeUrl || '(none — deep_offline)',
    });

    if (streaming) {
      log.warn('send() BLOCKED — already streaming, ignoring new question');
      return;
    }

    const userMsg = { id: Date.now(), role: 'user', content: question };
    const assistantId = Date.now() + 1;

    log.debug('send() adding user message id:', userMsg.id);
    setMessages(prev => [...prev, userMsg]);

    // ── MODE 3: Deep offline — local hybrid search + parent_id dedup ─────
    if (mode === 'deep_offline') {
      log.info('send() → ROUTE: MODE 3 (deep_offline) — local hybrid search + dedup');

      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '',
        is_offline: true, offline_chunks: [],
      }]);
      setStreaming(true);
      setStatusText('Searching local database…');

      const startMs = Date.now();

      try {
        log.info('send() [MODE 3] calling localSearch() — topK=10');
        // Fetch 10 candidates to give dedup enough material.
        const rawChunks = await localSearch(question, 10); // P4: hybrid search

        // ── NEW: Log all offline retrieval chunks for comparison ──────────
        console.log(
          `[OFFLINE/RAW] searchChunks returned ${rawChunks.length} candidates`
        );
        rawChunks.forEach((c, i) => {
          console.log(
            `[OFFLINE/RAW] chunk[${i}] src=${c.source} p=${c.page} score=${c.score?.toFixed(4)} content_preview="${c.content?.slice(0, 60).replace(/\n/g, ' ')}"`
          );
        });
        // ──────────────────────────────────────────────────────────────────


        log.info('send() [MODE 3] localSearch() returned', rawChunks.length,
          'candidates in', Date.now() - startMs, 'ms — starting dedup');

        // ── NEW: parent_id dedup (mirrors ChainResponse.get_citations()) ──
        const dedupedChunks = [];
        const seenParents = new Set();

        for (const chunk of rawChunks) {
          // Determine the dedup key: parent_id if available, else source|page.
          // This matches the online pipeline:
          //   if parent_id is non-empty -> use parent_id
          //   else fallback to "source|page"
          const key = chunk.parent_id
            ? chunk.parent_id
            : `${chunk.source}|${chunk.page ?? 0}`;

          if (seenParents.has(key)) {
            log.debug(`send() [MODE 3] dedup — dropping ${chunk.source}:p${chunk.page} (already seen key: ${key})`);
            continue;
          }
          seenParents.add(key);
          dedupedChunks.push(chunk);
          if (dedupedChunks.length >= 5) break; // limit to 5 unique parents
        }

        log.info('send() [MODE 3] dedup complete —', dedupedChunks.length,
          'unique parents kept out of', rawChunks.length, 'candidates',
          `(seen: ${seenParents.size})`);

        // ── Map to final chunk objects for display ───────────────────────
        const chunks = dedupedChunks.map(c => ({
          source: c.source,
          page: c.page,
          content: c.parent_content || c.content,
          score: c.score || 0,
          chunk_type: c.chunk_type || 'text',
          section_path: c.section_path || '',
          heading: c.heading || '',
          bbox: c.bbox || null,
        }));

        log.info('send() [MODE 3] displaying', chunks.length, 'chunks:',
          chunks.map(c => `${c.source}:p${c.page}(score=${c.score.toFixed(3)})`).join(', '));

        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, offline_chunks: chunks } : m
        ));

        log.info('send() [MODE 3] COMPLETE — total time:', Date.now() - startMs, 'ms');
      } catch (err) {
        log.error('send() [MODE 3] localSearch() FAILED:', err.message, err);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `⚠️ Local search failed: ${err.message}`, isError: true }
            : m
        ));
      } finally {
        setStreaming(false);
        setStatusText('');
        log.debug('send() [MODE 3] streaming=false, statusText cleared');
      }
      return;
    }

    // ── MODE 2: Intranet only (server up, no internet / Groq) ────────────
    if (mode === 'intranet_only') {
      log.info('send() → ROUTE: MODE 2 (intranet_only) — server-side retrieval');

      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '',
        is_offline: true, offline_chunks: [],
      }]);
      setStreaming(true);
      setStatusText('Searching manual sections…');

      const startMs = Date.now();

      try {
        log.info('send() [MODE 2] calling fetchOfflineResponse()', {
          question: question.slice(0, 80),
          pinnedFile: pinnedFile || '(none)',
          activeUrl,
        });

        const result = await fetchOfflineResponse(question, pinnedFile, activeUrl);

        log.info('send() [MODE 2] fetchOfflineResponse() returned',
          result.chunks?.length ?? 0, 'chunks in', Date.now() - startMs, 'ms');

        if (result.chunks?.length) {
          log.debug('send() [MODE 2] chunk sources:',
            result.chunks.map(c => `${c.source}:p${c.page}`).join(', '));
        }

        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, offline_chunks: result.chunks || [] }
            : m
        ));

        log.info('send() [MODE 2] COMPLETE — total time:', Date.now() - startMs, 'ms');
      } catch (err) {
        log.error('send() [MODE 2] fetchOfflineResponse() FAILED:', err.message, err);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `⚠️ ${err.message}`, isError: true }
            : m
        ));
      } finally {
        setStreaming(false);
        setStatusText('');
        log.debug('send() [MODE 2] streaming=false, statusText cleared');
      }
      return;
    }

    // ── MODE 1: Full online — XHR SSE streaming ──────────────────────────
    log.info('send() → ROUTE: MODE 1 (full_online) — SSE streaming via Groq');

    setMessages(prev => [...prev, {
      id: assistantId, role: 'assistant', content: '',
      streaming: true, citations: [], image_urls: [],
    }]);
    setStreaming(true);
    setStatusText('Searching documents…');

    let firstToken = false;
    let tokenCount = 0;
    const startMs = Date.now();

    log.info('send() [MODE 1] opening SSE stream …');

    const cancel = streamChat(question, 'default', pinnedFile, {
      onEvent: (event) => {
        // ── Token delta ──────────────────────────────────────────────────
        if (event.token !== undefined) {
          tokenCount++;

          if (!firstToken) {
            firstToken = true;
            log.info('send() [MODE 1] FIRST TOKEN received — time-to-first-token:',
              Date.now() - startMs, 'ms');
            setStatusText('');
          }

          if (tokenCount % 50 === 0) {
            log.debug(`send() [MODE 1] streaming … ${tokenCount} tokens so far`);
          }

          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, content: m.content + event.token }
              : m
          ));
        }

        // ── Done event ───────────────────────────────────────────────────
        else if (event.done === true) {
          log.info('send() [MODE 1] DONE event received', {
            totalTokens: tokenCount,
            elapsedMs: Date.now() - startMs,
            citations: event.citations?.length ?? 0,
            image_urls: event.image_urls?.length ?? 0,
            usage: event.usage,
          });

          if (event.citations?.length) {
            log.debug('send() [MODE 1] citations:',
              event.citations.map(c => `${c.source}:p${c.page}`).join(', '));
          }

          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? {
                ...m,
                streaming: false,
                citations: event.citations || [],
                image_urls: event.image_urls || [],
                usage: event.usage || {},
              }
              : m
          ));
          setStreaming(false);
          setStatusText('');
          log.debug('send() [MODE 1] streaming=false after done event');
        }

        // ── Error event from server ──────────────────────────────────────
        else if (event.type === 'error' || event.error) {
          log.error('send() [MODE 1] server error event:', event.message || event.error);
          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, content: `⚠️ ${event.message || event.error}`, streaming: false }
              : m
          ));
          setStreaming(false);
          setStatusText('');
        }

        // ── Unknown event ────────────────────────────────────────────────
        else {
          log.debug('send() [MODE 1] unhandled event type:', JSON.stringify(event).slice(0, 100));
        }
      },

      onDone: () => {
        log.info('send() [MODE 1] SSE connection onDone — tokens streamed:', tokenCount,
          '| elapsed:', Date.now() - startMs, 'ms');
        setMessages(prev => prev.map(m =>
          m.id === assistantId && m.streaming ? { ...m, streaming: false } : m
        ));
        setStreaming(false);
        setStatusText('');
      },

      onError: (err) => {
        log.error('send() [MODE 1] SSE connection ERROR:', err.message, err);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `⚠️ ${err.message}`, streaming: false }
            : m
        ));
        setStreaming(false);
        setStatusText('');
      },
    }, activeUrl);

    cancelRef.current = cancel;
    log.debug('send() [MODE 1] SSE stream started, cancelRef stored');
  }, [streaming, activeUrl]);

  // ── cancel() ─────────────────────────────────────────────────────────────
  const cancel = useCallback(() => {
    log.info('cancel() called — aborting current stream');
    cancelRef.current?.();
    setStreaming(false);
    setStatusText('');
  }, []);

  // ── clear() ──────────────────────────────────────────────────────────────
  const clear = useCallback(async () => {
    log.info('clear() called — cancelling stream and clearing messages');
    cancelRef.current?.();

    try {
      log.debug('clear() → clearSession() on server');
      await clearSession('default', activeUrl);
      log.info('clear() server session cleared');
    } catch (err) {
      log.warn('clear() clearSession() failed (ignored if offline):', err.message);
    }

    setMessages([]);
    log.info('clear() DONE — messages reset to []');
  }, [activeUrl]);

  return { messages, streaming, statusText, send, clear, cancel };
}