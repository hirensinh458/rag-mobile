// src/hooks/useChat.js
//
// FINAL VERSION — Mode 3 (DEEP_OFFLINE) now uses real local SQLite search
// via useOfflineSearch instead of the placeholder stub.
//
// Three complete branches:
//   ONLINE       → XHR SSE streaming to /chat/stream
//   LAN_ONLY     → POST /chat/offline (server retrieval, no LLM)
//   DEEP_OFFLINE → searchChunks() against local SQLite FTS5 index

import { useState, useCallback, useRef }       from 'react';
import { streamChat, fetchOfflineResponse, clearSession } from '../api/chat';
import { NetworkMode }                          from './useNetwork';
import { searchChunks }                         from '../offline/db';

export function useChat() {
  const [messages,   setMessages]   = useState([]);
  const [streaming,  setStreaming]  = useState(false);
  const [statusText, setStatusText] = useState('');
  const cancelRef = useRef(null);

  // ── HELPER ─────────────────────────────────────────────────
  const patchMsg = useCallback((id, patch) => {
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  // ─────────────────────────────────────────────────────────
  // SEND
  // ─────────────────────────────────────────────────────────
  const send = useCallback(async (
    question,
    mode       = NetworkMode.ONLINE,
    pinnedFile = null,
  ) => {
    if (streaming) return;

    const userMsg     = { id: Date.now(),     role: 'user', content: question };
    const assistantId =   Date.now() + 1;
    setMessages(prev => [...prev, userMsg]);


    // ── MODE 3: Deep offline — local SQLite FTS5 search ────────────
    if (mode === NetworkMode.DEEP_OFFLINE) {
      setMessages(prev => [...prev, {
        id:             assistantId,
        role:           'assistant',
        is_offline:     true,
        offline_chunks: [],
        content:        '',
        citations:      [],
        _deepOffline:   true,
      }]);
      setStreaming(true);
      setStatusText('Searching local database…');

      try {
        const rawChunks = await searchChunks(question, 5);

        if (rawChunks.length === 0) {
          patchMsg(assistantId, {
            offline_chunks: [],
            content: '⚡ No matching sections found in local database. ' +
                     'Connect to the server to sync the latest documents.',
          });
        } else {
          // Shape to match what MessageBubble / OfflineChunkCard expects
          const chunks = rawChunks.map((c, i) => ({
            id:      c.id || i,
            source:  c.source,
            content: c.content,   // already parent_content from db.searchChunks
            page:    c.page,
            type:    c.chunk_type || 'text',
            score:   c.score,
            rank:    i + 1,
          }));
          patchMsg(assistantId, { offline_chunks: chunks });
        }
      } catch (err) {
        console.error('[useChat] Local search error:', err);
        patchMsg(assistantId, {
          content: `⚡ Local search failed: ${err.message}`,
          isError: true,
        });
      } finally {
        setStreaming(false);
        setStatusText('');
      }
      return;
    }


    // ── MODE 2: LAN only — server retrieval, no LLM ─────────────────
    if (mode === NetworkMode.LAN_ONLY) {
      setMessages(prev => [...prev, {
        id:             assistantId,
        role:           'assistant',
        is_offline:     true,
        offline_chunks: [],
        content:        '',
        citations:      [],
      }]);
      setStreaming(true);
      setStatusText('Searching manual sections…');

      try {
        const result = await fetchOfflineResponse(question, pinnedFile);
        patchMsg(assistantId, { offline_chunks: result.chunks ?? [] });
      } catch (err) {
        patchMsg(assistantId, {
          content: `⚠️ ${err.message}`,
          isError: true,
        });
      } finally {
        setStreaming(false);
        setStatusText('');
      }
      return;
    }


    // ── MODE 1: Full online — XHR SSE streaming ──────────────────────
    setMessages(prev => [...prev, {
      id:         assistantId,
      role:       'assistant',
      content:    '',
      streaming:  true,
      citations:  [],
      image_urls: [],
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
              : m,
          ));

        } else if (event.done === true) {
          patchMsg(assistantId, {
            streaming:  false,
            citations:  event.citations   || [],
            image_urls: event.image_urls  || [],
            usage:      event.usage       || {},
          });
          setStreaming(false);
          setStatusText('');

        } else if (event.type === 'error' || event.error) {
          patchMsg(assistantId, {
            content:   `⚠️ ${event.message || event.error}`,
            streaming: false,
          });
          setStreaming(false);
          setStatusText('');
        }
      },

      onDone: () => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId && m.streaming
            ? { ...m, streaming: false }
            : m,
        ));
        setStreaming(false);
        setStatusText('');
      },

      onError: (err) => {
        patchMsg(assistantId, {
          content:   `⚠️ ${err.message}`,
          streaming: false,
        });
        setStreaming(false);
        setStatusText('');
      },
    });

    cancelRef.current = cancel;
  }, [streaming, patchMsg]);


  // ── CANCEL / CLEAR ─────────────────────────────────────────
  const cancel = useCallback(() => {
    cancelRef.current?.();
    setStreaming(false);
    setStatusText('');
  }, []);

  const clear = useCallback(async () => {
    cancelRef.current?.();
    await clearSession().catch(() => {});
    setMessages([]);
  }, []);

  return { messages, streaming, statusText, send, clear, cancel };
}