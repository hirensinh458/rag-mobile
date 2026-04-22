// src/hooks/useChat.js
import { useState, useCallback, useRef } from 'react';
import { streamChat, fetchOfflineResponse, clearSession } from '../api/chat';

export function useChat() {
    const [messages, setMessages] = useState([]);
    const [streaming, setStreaming] = useState(false);
    const [statusText, setStatusText] = useState('');
    const cancelRef = useRef(null); // holds the abort fn for active stream

    const send = useCallback(async (question, isOnline = true, pinnedFile = null) => {
        if (streaming) return;

        const userMsg = { id: Date.now(), role: 'user', content: question };
        const assistantId = Date.now() + 1;
        setMessages(prev => [...prev, userMsg]);

        // ── OFFLINE ────────────────────────────────────────────────
        if (!isOnline) {
            setMessages(prev => [...prev, {
                id: assistantId, role: 'assistant', content: '',
                is_offline: true, offline_chunks: [], citations: [],
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

        // ── ONLINE (XHR SSE) ───────────────────────────────────────
        setMessages(prev => [...prev, {
            id: assistantId, role: 'assistant', content: '',
            streaming: true, citations: [], image_urls: [],
        }]);
        setStreaming(true);
        setStatusText('Searching documents…');

        let firstToken = false;

        const cancel = streamChat(question, 'default', pinnedFile, {
            onEvent: (event) => {
                // Backend sends {token: "..."} not {type: "token", token: "..."}
                if (event.token !== undefined) {
                    if (!firstToken) {
                        firstToken = true;
                        setStatusText('');
                    }
                    setMessages(prev => prev.map(m =>
                        m.id === assistantId
                            ? { ...m, content: m.content + event.token }
                            : m
                    ));

                    // Backend sends {done: true, citations: [...]} not {type: "done"}
                } else if (event.done === true) {
                    setMessages(prev => prev.map(m =>
                        m.id === assistantId
                            ? {
                                ...m,
                                streaming: false,
                                citations: event.citations || [],
                                image_urls: event.image_urls || [],
                                usage: event.usage || {}
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
                // Fired by xhr.onload — ensures streaming state clears even if
                // the backend doesn't send an explicit 'done' event
                setMessages(prev => prev.map(m =>
                    m.id === assistantId && m.streaming
                        ? { ...m, streaming: false }
                        : m
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
        await clearSession();
        setMessages([]);
    }, []);

    return { messages, streaming, statusText, send, clear, cancel };
}