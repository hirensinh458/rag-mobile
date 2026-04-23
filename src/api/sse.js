// src/api/sse.js
//
// CHANGE: streamSSE() now accepts a `baseUrl` parameter so the active
// server URL from useNetwork.activeUrl can be used instead of the
// hardcoded Config.API_BASE_URL. Falls back to Config.API_BASE_URL when
// not provided (preserves backward compatibility).

import { Config } from '../config';

export function streamSSE(path, body, onEvent, onDone, onError, baseUrl) {
  const base = baseUrl || Config.API_BASE_URL;
  const xhr  = new XMLHttpRequest();
  const url  = `${base}${path}`;

  console.log('[SSE] Opening connection to:', url);

  xhr.open('POST', url, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('Accept', 'text/event-stream');

  let lastIndex = 0;
  let buffer    = '';
  let progressCount = 0;

  xhr.onprogress = () => {
    progressCount++;
    console.log(`[SSE] onprogress fired #${progressCount}, responseText length:`, xhr.responseText?.length);

    const newData = xhr.responseText.slice(lastIndex);
    lastIndex = xhr.responseText.length;

    console.log('[SSE] new chunk raw:', JSON.stringify(newData.slice(0, 200)));

    buffer += newData;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      console.log('[SSE] line:', JSON.stringify(line));
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') { console.log('[SSE] got [DONE]'); onDone?.(); return; }
      try {
        const parsed = JSON.parse(raw);
        console.log('[SSE] parsed event:', JSON.stringify(parsed));
        onEvent(parsed);
      } catch (e) {
        console.log('[SSE] JSON parse error:', e.message, 'raw was:', raw);
      }
    }
  };

  xhr.onload = () => {
    console.log('[SSE] onload fired, status:', xhr.status);
    console.log('[SSE] final responseText length:', xhr.responseText?.length);
    console.log('[SSE] final responseText (first 500):', xhr.responseText?.slice(0, 500));
    onDone?.();
  };

  xhr.onerror = (e) => {
    console.log('[SSE] onerror:', e);
    onError?.(new Error('SSE connection failed'));
  };

  xhr.ontimeout = () => {
    console.log('[SSE] timeout fired');
    onError?.(new Error('SSE timeout'));
  };

  xhr.onreadystatechange = () => {
    console.log('[SSE] readyState changed:', xhr.readyState, 'status:', xhr.status);
  };

  xhr.timeout = 60000;
  xhr.send(JSON.stringify(body));

  console.log('[SSE] request sent');
  return xhr;
}