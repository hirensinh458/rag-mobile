// src/hooks/useChat.js  — P4: Mode 3 now uses localSearch (hybrid BM25+KNN)
//
// CHANGES FROM PREVIOUS VERSION:
//   - Mode 3 deep_offline path now calls localSearch() from useOfflineSearch
//     instead of searchChunks() from db.js directly.
//   - localSearch() embeds the query on-device and runs hybridSearchChunks()
//     (BM25 + KNN + RRF). Falls back to BM25-only if embedder unavailable.
//   - topK raised to 10 candidates before slicing to 5 for display (same as before)
//   - All other modes (1 and 2) unchanged.

import { useState, useCallback, useRef } from 'react';
import { streamChat, fetchOfflineResponse, clearSession } from '../api/chat';
import { localSearch }  from './useOfflineSearch';  // P4: hybrid search

/**
 * @param {string} activeUrl — the currently working server URL from useNetwork.
 *                             Empty string when deep_offline.
 */
export function useChat(activeUrl = '') {
  const [messages,   setMessages]   = useState([]);
  const [streaming,  setStreaming]  = useState(false);
  const [statusText, setStatusText] = useState('');
  const cancelRef = useRef(null);

  /**
   * send(question, mode, pinnedFile)
   *
   * Mode 1 full_online   — XHR SSE stream to /chat/stream (Groq LLM)
   * Mode 2 intranet_only — POST /chat/offline (server-side retrieval)
   * Mode 3 deep_offline  — local hybrid search via localSearch() [P4]
   */
  const send = useCallback(async (question, mode = 'full_online', pinnedFile = null) => {
    if (streaming) return;

    const userMsg     = { id: Date.now(), role: 'user', content: question };
    const assistantId = Date.now() + 1;
    setMessages(prev => [...prev, userMsg]);

    // ── MODE 3: Deep offline — local hybrid BM25+KNN search ──────────────
    if (mode === 'deep_offline') {
      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '',
        is_offline: true, offline_chunks: [],
      }]);
      setStreaming(true);
      setStatusText('Searching local database…');

      try {
        // Request 10 candidates — RRF merge then slice to top 5 for display.
        // This gives better coverage than requesting 5 directly.
        const rawChunks = await localSearch(question, 10); // P4: hybrid search
        const chunks = rawChunks.slice(0, 5).map(c => ({
          source:       c.source,
          page:         c.page,
          content:      c.parent_content || c.content,
          score:        c.score || 0,
          chunk_type:   c.chunk_type   || 'text',
          section_path: c.section_path || '',
          heading:      c.heading      || '',
          bbox:         c.bbox         || null,
        }));
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, offline_chunks: chunks } : m
        ));
      } catch (err) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `⚠️ Local search failed: ${err.message}`, isError: true }
            : m
        ));
      } finally {
        setStreaming(false);
        setStatusText('');
      }
      return;
    }

    // ── MODE 2: Intranet only (server up, no internet / Groq) ────────────
    if (mode === 'intranet_only') {
      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '',
        is_offline: true, offline_chunks: [],
      }]);
      setStreaming(true);
      setStatusText('Searching manual sections…');

      try {
        const result = await fetchOfflineResponse(question, pinnedFile, activeUrl);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, offline_chunks: result.chunks || [] }
            : m
        ));
      } catch (err) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `⚠️ ${err.message}`, isError: true }
            : m
        ));
      } finally {
        setStreaming(false);
        setStatusText('');
      }
      return;
    }

    // ── MODE 1: Full online — XHR SSE streaming ──────────────────────────
    setMessages(prev => [...prev, {
      id: assistantId, role: 'assistant', content: '',
      streaming: true, citations: [], image_urls: [],
    }]);
    setStreaming(true);
    setStatusText('Searching documents…');

    let firstToken = false;

    const cancel = streamChat(question, 'default', pinnedFile, {
      onEvent: (event) => {
        if (event.token !== undefined) {
          if (!firstToken) { firstToken = true; setStatusText(''); }
          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, content: m.content + event.token }
              : m
          ));
        } else if (event.done === true) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? {
                  ...m,
                  streaming:  false,
                  citations:  event.citations  || [],
                  image_urls: event.image_urls || [],
                  usage:      event.usage      || {},
                }
              : m
          ));
          setStreaming(false);
          setStatusText('');
        } else if (event.type === 'error' || event.error) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, content: `⚠️ ${event.message || event.error}`, streaming: false }
              : m
          ));
          setStreaming(false);
          setStatusText('');
        }
      },
      onDone: () => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId && m.streaming ? { ...m, streaming: false } : m
        ));
        setStreaming(false);
        setStatusText('');
      },
      onError: (err) => {
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
  }, [streaming, activeUrl]);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    setStreaming(false);
    setStatusText('');
  }, []);

  const clear = useCallback(async () => {
    cancelRef.current?.();
    try { await clearSession('default', activeUrl); } catch { /* ignore if offline */ }
    setMessages([]);
  }, [activeUrl]);

  return { messages, streaming, statusText, send, clear, cancel };
}