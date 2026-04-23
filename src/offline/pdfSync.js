// src/offline/pdfSync.js
//
// CHANGE: syncPdfs() and getLocalPdfUri() now accept an optional `activeUrl`
// parameter so the correct server URL (from useNetwork.activeUrl) is used
// instead of the cached Config.API_BASE_URL.

import * as FileSystem from 'expo-file-system/legacy';  // ← legacy import fixes warning
import { apiFetch }    from '../api/client';
import { Config }      from '../config';

export const PDF_DIR = FileSystem.documentDirectory + 'pdfs/';

async function ensurePdfDir() {
  const info = await FileSystem.getInfoAsync(PDF_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(PDF_DIR, { intermediates: true });
  }
}

/**
 * Returns local file URI if the PDF is cached, or null.
 */
export async function getLocalPdfUri(filename) {
  try {
    const path = PDF_DIR + filename;
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? path : null;
  } catch {
    return null;
  }
}

/**
 * Sync all PDFs from the server.
 * Downloads any PDFs not cached locally.
 * Removes PDFs no longer on the server.
 *
 * @param {string} activeUrl — base URL from useNetwork (optional, falls back to Config)
 */
export async function syncPdfs(activeUrl = '') {
  await ensurePdfDir();

  const base = activeUrl || Config.API_BASE_URL;

  let serverFiles = [];
  try {
    const res  = await apiFetch('/documents', activeUrl);
    const data = await res.json();
    serverFiles = (data.files || []).filter(
      f => typeof f === 'string' && f.toLowerCase().endsWith('.pdf')
    );
  } catch (e) {
    console.warn('[PDF SYNC] /documents failed:', e.message);
    return { synced: [], deleted: [], errors: [e.message] };
  }

  let localFiles = [];
  try { localFiles = await FileSystem.readDirectoryAsync(PDF_DIR); }
  catch { localFiles = []; }

  const serverSet = new Set(serverFiles);
  const localSet  = new Set(localFiles);
  const synced = [], deleted = [], errors = [];

  for (const filename of serverFiles) {
    if (localSet.has(filename)) continue;
    const remoteUrl = `${base}/pdfs/${encodeURIComponent(filename)}`;
    const localPath = PDF_DIR + filename;
    try {
      const result = await FileSystem.downloadAsync(remoteUrl, localPath);
      if (result.status === 200) { synced.push(filename); }
      else { errors.push(`${filename}: HTTP ${result.status}`); }
    } catch (e) {
      errors.push(`${filename}: ${e.message}`);
    }
  }

  for (const filename of localFiles) {
    if (!serverSet.has(filename)) {
      try {
        await FileSystem.deleteAsync(PDF_DIR + filename, { idempotent: true });
        deleted.push(filename);
      } catch (e) {
        errors.push(`delete ${filename}: ${e.message}`);
      }
    }
  }

  console.log(`[PDF SYNC] ↓${synced.length} 🗑${deleted.length} ✗${errors.length}`);
  return { synced, deleted, errors };
}