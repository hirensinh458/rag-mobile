// src/components/PdfViewer.js
//
// CHANGES:
//   - Now accepts `mode` and `serverUrl` props from ChatScreen.
//     Previously it always used Config.API_BASE_URL (broke in Mode 3).
//   - In deep_offline mode, resolves source from the local PDF cache
//     (FileSystem.documentDirectory/pdfs/) instead of making a network request.
//   - Shows a clear error if the PDF hasn't been synced yet in deep_offline.
//   - serverUrl is now explicit (not re-read from AsyncStorage on every open).

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Modal, Platform, Linking,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';   // ← legacy import
import { colors, spacing, radius, typography, minTapTarget } from '../config/theme';

// PDF_DIR must match pdfSync.js
const PDF_DIR = FileSystem.documentDirectory + 'pdfs/';

// Try to load react-native-pdf — only works after EAS build
let Pdf = null;
try { Pdf = require('react-native-pdf').default; } catch { /* needs EAS build */ }

/**
 * Full-screen PDF viewer.
 *
 * Mode 1/2 (online or intranet): streams PDF from serverUrl/pdfs/<filename>
 * Mode 3 (deep_offline):         reads from local FileSystem cache
 *
 * Before EAS build (react-native-pdf not available):
 *   → auto-opens the PDF in the device browser/PDF app via HTTP URL
 *
 * After EAS build:
 *   → renders in-app with react-native-pdf, jumping to the correct page
 *
 * Props:
 *   filename   string  — e.g. "engine_manual.pdf"
 *   page       number  — page to jump to (1-indexed)
 *   bbox       array   — reserved for future highlight [x0,y0,x1,y1]
 *   serverUrl  string  — base server URL from ChatScreen (e.g. 'http://192.168.1.X:8001')
 *   mode       string  — 'full_online' | 'intranet_only' | 'deep_offline'
 *   onClose    fn      — dismiss callback
 */
export function PdfViewer({ filename, page = 1, bbox, serverUrl = '', mode = 'full_online', onClose }) {
  const [status,     setStatus]     = useState('loading');  // 'loading' | 'ready' | 'error' | 'opened'
  const [source,     setSource]     = useState(null);
  const [totalPages, setTotalPages] = useState(0);
  const [curPage,    setCurPage]    = useState(page);
  const [errorMsg,   setErrorMsg]   = useState('');

  useEffect(() => {
    async function resolveSource() {
      if (mode === 'deep_offline') {
        // Deep offline — must use local file
        const localPath = `${PDF_DIR}${filename}`;
        try {
          const info = await FileSystem.getInfoAsync(localPath);
          if (info.exists) {
            setSource({ uri: localPath, cache: false });
            setStatus(Pdf ? 'ready' : 'opening');
            if (!Pdf) {
              // No native viewer — open via Linking (file:// on device)
              Linking.openURL(localPath)
                .then(() => setStatus('opened'))
                .catch(e => { setErrorMsg(e.message || 'Could not open file'); setStatus('error'); });
            }
          } else {
            setErrorMsg('PDF not synced. Connect to the server and tap "Sync from Server" in Settings.');
            setStatus('error');
          }
        } catch (e) {
          setErrorMsg(`Could not check local file: ${e.message}`);
          setStatus('error');
        }
      } else {
        // Mode 1 or 2 — use network URL
        if (!serverUrl) {
          setErrorMsg('Server URL not configured. Check Settings.');
          setStatus('error');
          return;
        }

        if (Pdf) {
          // Native viewer — try local cache first, fall back to network
          try {
            const localPath = `${PDF_DIR}${filename}`;
            const info = await FileSystem.getInfoAsync(localPath);
            setSource(
              info.exists
                ? { uri: localPath,                                            cache: false }
                : { uri: `${serverUrl}/pdfs/${encodeURIComponent(filename)}`, cache: true  }
            );
            setStatus('ready');
          } catch {
            setSource({ uri: `${serverUrl}/pdfs/${encodeURIComponent(filename)}`, cache: true });
            setStatus('ready');
          }
        } else {
          // No native module — open in browser
          const networkUrl = `${serverUrl}/pdfs/${encodeURIComponent(filename)}`;
          setStatus('opening');
          Linking.openURL(networkUrl)
            .then(() => setStatus('opened'))
            .catch(e => { setErrorMsg(e.message || 'Could not open URL'); setStatus('error'); });
        }
      }
    }

    resolveSource();
  }, [filename, mode, serverUrl]);

  // Convenience: the URL to show in the "Direct URL" box (only for network modes)
  const networkUrl = serverUrl
    ? `${serverUrl}/pdfs/${encodeURIComponent(filename)}`
    : '';

  // ── No native PDF module: show status + manual link ─────────────────────
  if (!Pdf) {
    return (
      <Modal visible animationType="slide" onRequestClose={onClose}>
        <View style={styles.root}>
          <PdfHeader filename={filename} onClose={onClose} />

          <View style={styles.centered}>
            {status === 'opening' && (
              <>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.statusText}>Opening PDF…</Text>
                <Text style={styles.hintText}>{filename}</Text>
              </>
            )}

            {status === 'opened' && (
              <>
                <Text style={styles.bigIcon}>✅</Text>
                <Text style={styles.statusText}>PDF opened</Text>
                <Text style={styles.hintText}>
                  {mode === 'deep_offline'
                    ? 'Opened from local storage.'
                    : `Page ${page} — scroll to find it manually.\nIn-app viewer available after EAS build.`}
                </Text>
                {networkUrl ? (
                  <TouchableOpacity
                    style={styles.secondaryBtn}
                    onPress={() => Linking.openURL(networkUrl)}
                  >
                    <Text style={styles.secondaryBtnText}>Open again →</Text>
                  </TouchableOpacity>
                ) : null}
              </>
            )}

            {status === 'error' && (
              <>
                <Text style={styles.bigIcon}>⚠️</Text>
                <Text style={styles.errorText}>
                  {errorMsg || 'Could not open PDF.'}
                </Text>
                {networkUrl ? (
                  <TouchableOpacity
                    style={styles.primaryBtn}
                    onPress={() => Linking.openURL(networkUrl).catch(() => {})}
                  >
                    <Text style={styles.primaryBtnText}>Retry</Text>
                  </TouchableOpacity>
                ) : null}
              </>
            )}

            {/* Always show URL as last resort — only in network modes */}
            {networkUrl ? (
              <View style={styles.urlBox}>
                <Text style={styles.urlLabel}>Direct URL:</Text>
                <Text style={styles.urlText} numberOfLines={2}>{networkUrl}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    );
  }

  // ── Native PDF viewer (after EAS build) ──────────────────────────────────
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.root}>
        <PdfHeader
          filename={filename}
          page={curPage}
          totalPages={totalPages}
          onClose={onClose}
        />

        {status === 'loading' && (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.statusText}>Loading {filename}…</Text>
          </View>
        )}

        {status === 'error' && (
          <View style={styles.centered}>
            <Text style={styles.bigIcon}>⚠️</Text>
            <Text style={styles.errorText}>{errorMsg || 'Failed to load PDF'}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={onClose}>
              <Text style={styles.primaryBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        )}

        {status === 'ready' && source && (
          <Pdf
            source={source}
            page={page}
            onLoadComplete={(n) => { setTotalPages(n); setStatus('ready'); }}
            onPageChanged={(p)  => setCurPage(p)}
            onError={(e)        => { setErrorMsg(String(e)); setStatus('error'); }}
            style={styles.pdf}
            trustAllCerts={false}
            fitPolicy={0}
            horizontal={false}
          />
        )}
      </View>
    </Modal>
  );
}

// ── Header ────────────────────────────────────────────────────────────────

function PdfHeader({ filename, page, totalPages, onClose }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerInfo}>
        <Text style={styles.headerFilename} numberOfLines={1}>📖  {filename}</Text>
        {totalPages > 0 && (
          <Text style={styles.headerPage}>Page {page} / {totalPages}</Text>
        )}
      </View>
      <TouchableOpacity
        style={styles.closeBtn}
        onPress={onClose}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={styles.closeBtnText}>✕  Close</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },

  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    backgroundColor:   colors.bg1,
    paddingHorizontal: spacing.lg,
    paddingTop:        Platform.OS === 'ios' ? 52 : spacing.lg,
    paddingBottom:     spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerInfo:     { flex: 1, marginRight: spacing.md },
  headerFilename: {
    fontSize:   typography.fontSize.md,
    color:      colors.teal,
    fontFamily: typography.fontMono,
  },
  headerPage: {
    fontSize:   typography.fontSize.sm,
    color:      colors.text3,
    marginTop:  3,
    fontFamily: typography.fontMono,
  },
  closeBtn: {
    backgroundColor:   colors.bg3,
    borderRadius:      radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    borderWidth:       1,
    borderColor:       colors.borderMd,
    minHeight:         minTapTarget,
    justifyContent:    'center',
  },
  closeBtnText: { color: colors.text1, fontSize: typography.fontSize.sm },

  pdf: { flex: 1, width: '100%', backgroundColor: '#111' },

  centered: {
    flex:              1,
    alignItems:        'center',
    justifyContent:    'center',
    padding:           spacing.xl,
    gap:               spacing.md,
  },
  bigIcon:    { fontSize: 52 },
  statusText: {
    fontSize:   typography.fontSize.lg,
    color:      colors.text0,
    textAlign:  'center',
    fontWeight: '600',
  },
  hintText: {
    fontSize:   typography.fontSize.sm,
    color:      colors.text3,
    textAlign:  'center',
    lineHeight: 20,
    fontFamily: typography.fontMono,
  },
  errorText: {
    fontSize:   typography.fontSize.md,
    color:      colors.error,
    textAlign:  'center',
    lineHeight: 22,
  },
  primaryBtn: {
    backgroundColor:   colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical:   spacing.md,
    borderRadius:      radius.md,
    minHeight:         minTapTarget,
    justifyContent:    'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: typography.fontSize.md },
  secondaryBtn: {
    backgroundColor:   colors.bg3,
    paddingHorizontal: spacing.xl,
    paddingVertical:   spacing.md,
    borderRadius:      radius.md,
    borderWidth:       1,
    borderColor:       colors.borderMd,
    minHeight:         minTapTarget,
    justifyContent:    'center',
  },
  secondaryBtnText: { color: colors.text1, fontWeight: '600', fontSize: typography.fontSize.md },
  urlBox: {
    marginTop:         spacing.md,
    backgroundColor:   colors.bg3,
    borderRadius:      radius.md,
    padding:           spacing.md,
    borderWidth:       1,
    borderColor:       colors.border,
    width:             '100%',
  },
  urlLabel: {
    fontSize:   typography.fontSize.xs,
    color:      colors.text3,
    fontFamily: typography.fontMono,
    marginBottom: 4,
  },
  urlText: {
    fontSize:   typography.fontSize.xs,
    color:      colors.teal,
    fontFamily: typography.fontMono,
  },
});