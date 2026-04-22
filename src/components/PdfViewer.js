// src/components/PdfViewer.js
import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Modal, Platform, Linking,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';   // ← legacy import
import { Config }      from '../config';
import { colors, spacing, radius, typography, minTapTarget } from '../config/theme';

// PDF_DIR must match pdfSync.js
const PDF_DIR = FileSystem.documentDirectory + 'pdfs/';

// Try to load react-native-pdf — only works after EAS build
let Pdf = null;
try { Pdf = require('react-native-pdf').default; } catch { /* needs EAS build */ }

/**
 * Full-screen PDF viewer.
 *
 * Before EAS build (react-native-pdf not available):
 *   → auto-opens the PDF in the device browser/PDF app via HTTP URL
 *
 * After EAS build:
 *   → renders in-app with react-native-pdf, jumping to the correct page
 *
 * Props:
 *   filename  string  — e.g. "engine_manual.pdf"
 *   page      number  — page to jump to (1-indexed)
 *   bbox      array   — reserved for future highlight
 *   onClose   fn      — dismiss callback
 */
export function PdfViewer({ filename, page = 1, bbox, onClose }) {
  const [status,     setStatus]     = useState('loading');  // 'loading' | 'ready' | 'error' | 'opened'
  const [source,     setSource]     = useState(null);
  const [totalPages, setTotalPages] = useState(0);
  const [curPage,    setCurPage]    = useState(page);
  const [errorMsg,   setErrorMsg]   = useState('');

  // Build the server URL once (always valid in Mode 1 + Mode 2)
  const serverUrl = `${Config.API_BASE_URL}/pdfs/${encodeURIComponent(filename)}`;

  useEffect(() => {
    if (Pdf) {
      // Native viewer path — resolve whether to use local cache or server
      (async () => {
        try {
          const localPath = PDF_DIR + filename;
          const info = await FileSystem.getInfoAsync(localPath);
          setSource(
            info.exists
              ? { uri: localPath,   cache: false }
              : { uri: serverUrl,   cache: true  }
          );
          setStatus('ready');
        } catch (e) {
          // If file-system check fails just use server URL
          setSource({ uri: serverUrl, cache: true });
          setStatus('ready');
        }
      })();
    } else {
      // No native module — open in browser immediately, then show "opened" state
      setStatus('opening');
      Linking.openURL(serverUrl)
        .then(() => setStatus('opened'))
        .catch((e) => {
          setErrorMsg(e.message || 'Could not open URL');
          setStatus('error');
        });
    }
  }, [filename, serverUrl]);

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
                <Text style={styles.statusText}>Opening PDF in browser…</Text>
                <Text style={styles.hintText}>{filename}</Text>
              </>
            )}

            {status === 'opened' && (
              <>
                <Text style={styles.bigIcon}>✅</Text>
                <Text style={styles.statusText}>PDF opened in browser</Text>
                <Text style={styles.hintText}>
                  Page {page} — scroll to find it manually.{'\n'}
                  In-app viewer available after EAS build.
                </Text>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => Linking.openURL(serverUrl)}
                >
                  <Text style={styles.secondaryBtnText}>Open again →</Text>
                </TouchableOpacity>
              </>
            )}

            {status === 'error' && (
              <>
                <Text style={styles.bigIcon}>⚠️</Text>
                <Text style={styles.errorText}>
                  Could not open PDF.{'\n'}
                  Make sure the server is reachable.
                </Text>
                {errorMsg ? <Text style={styles.hintText}>{errorMsg}</Text> : null}
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => Linking.openURL(serverUrl).catch(() => {})}
                >
                  <Text style={styles.primaryBtnText}>Retry</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Always show manual URL as last resort */}
            <View style={styles.urlBox}>
              <Text style={styles.urlLabel}>Direct URL:</Text>
              <Text style={styles.urlText} numberOfLines={2}>{serverUrl}</Text>
            </View>
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
  bigIcon:     { fontSize: 52 },
  statusText:  {
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