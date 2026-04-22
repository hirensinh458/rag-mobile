// src/hooks/useChat.js
import { useState, useCallback, useRef } from 'react';
import { streamChat, fetchOfflineResponse, clearSession } from '../api/chat';
import { searchChunks } from '../offline/db';  // Mode 3: local SQLite FTS

export function useChat() {
  const [messages,   setMessages]   = useState([]);
  const [streaming,  setStreaming]  = useState(false);
  const [statusText, setStatusText] = useState('');
  const cancelRef = useRef(null);

  /**
   * send(question, mode, pinnedFile)
   *
   * mode: 'full_online' | 'intranet_only' | 'deep_offline'
   *
   * Mode 1 full_online   — XHR SSE stream to /chat/stream (Groq LLM)
   * Mode 2 intranet_only — POST /chat/offline (retrieval only, server-side)
   * Mode 3 deep_offline  — local SQLite FTS via db.searchChunks()
   */
  const send = useCallback(async (question, mode = 'full_online', pinnedFile = null) => {
    if (streaming) return;

    const userMsg     = { id: Date.now(), role: 'user', content: question };
    const assistantId = Date.now() + 1;
    setMessages(prev => [...prev, userMsg]);

    // ── MODE 3: Deep offline (no server connection) ──────────────────────
    if (mode === 'deep_offline') {
      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '',
        is_offline: true, offline_chunks: [],
      }]);
      setStreaming(true);
      setStatusText('Searching local database…');

      try {
        const rawChunks = await searchChunks(question, 5);
        // Normalize to the same shape as server offline chunks
        const chunks = rawChunks.map(c => ({
          source:       c.source,
          page:         c.page,
          content:      c.parent_content || c.content,
          score:        c.score || 0,
          chunk_type:   c.chunk_type || 'text',
          section_path: '',
          heading:      '',
          bbox:         null,
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
        const result = await fetchOfflineResponse(question, pinnedFile);
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
    });

    cancelRef.current = cancel;
  }, [streaming]);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    setStreaming(false);
    setStatusText('');
  }, []);

  const clear = useCallback(async () => {
    cancelRef.current?.();
    try { await clearSession(); } catch { /* ignore if offline */ }
    setMessages([]);
  }, []);

  return { messages, streaming, statusText, send, clear, cancel };
}