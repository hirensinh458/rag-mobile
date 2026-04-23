// src/components/OfflineChunkCard.js
//
// CHANGES:
//   - Fixed "Text strings must be rendered within a <Text> component" crash:
//       chunk.page and chunk.score can be 0 (falsy).
//       All guards changed from `{chunk.page && ...}` to `{chunk.page != null && ...}`
//   - Added `isPdfAvailableLocally` check so the "Open in manual" button only
//       shows in Mode 3 when the PDF has been downloaded during sync.
//       In Mode 1/2 the button always shows (server serves the PDF).
//   - Hint text shown when in deep_offline and PDF not yet synced.

import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, radius, typography } from '../config/theme';
import { isPdfAvailableLocally } from '../offline/db';

const TYPE_ICON = { image: '🖼', table: '⊞', text: '◈', heading: '◈' };

/**
 * Props:
 *   chunk      object   — chunk data from useChat
 *   onOpenPdf  fn       — (source, page, bbox) => void
 *   mode       string   — 'full_online' | 'intranet_only' | 'deep_offline'
 *                         When omitted defaults to non-offline behaviour
 *                         (button always shows for Mode 1/2).
 */
export function OfflineChunkCard({ chunk, onOpenPdf, mode }) {
  const [expanded,     setExpanded]     = useState(false);
  const [pdfAvailable, setPdfAvailable] = useState(true); // assume available until checked

  const isDeepOffline = mode === 'deep_offline';

  // In deep_offline mode, check whether the PDF was downloaded during sync.
  // In Mode 1/2 the server streams it, so we skip the local check.
  useEffect(() => {
    if (isDeepOffline && chunk.source) {
      isPdfAvailableLocally(chunk.source).then(setPdfAvailable);
    } else {
      setPdfAvailable(true);
    }
  }, [isDeepOffline, chunk.source]);

  const icon     = TYPE_ICON[chunk.chunk_type] || '◈';
  // Use != null so score of 0 doesn't evaluate to 0 (falsy) and break the bar
  const scorePct = chunk.score != null
    ? Math.min(100, Math.max(0, chunk.score * 100))
    : 0;
  const scoreColor = scorePct > 65 ? '#34d399' : scorePct > 35 ? '#fbbf24' : '#94a3b8';

  const canOpenPdf = onOpenPdf && chunk.source && (
    isDeepOffline ? pdfAvailable : chunk.page != null
  );

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.icon}>{icon}</Text>
        <Text style={styles.source} numberOfLines={1}>
          {chunk.source}
          {/* Use != null guard — page 0 is valid and should show */}
          {chunk.page != null ? ` · p${chunk.page}` : ''}
        </Text>
        <View style={[styles.scoreDot, { backgroundColor: scoreColor }]} />
      </View>

      {/* Section breadcrumb */}
      {chunk.section_path ? (
        <Text style={styles.breadcrumb} numberOfLines={1}>{chunk.section_path}</Text>
      ) : null}

      {/* Score bar — score can be 0, use != null */}
      {chunk.score != null && (
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${scorePct}%`, backgroundColor: scoreColor }]} />
        </View>
      )}

      {/* Content */}
      <Text style={styles.content} numberOfLines={expanded ? undefined : 4}>
        {chunk.content}
      </Text>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity onPress={() => setExpanded(e => !e)}>
          <Text style={styles.footerBtn}>{expanded ? 'Show less ↑' : 'Show more ↓'}</Text>
        </TouchableOpacity>

        {/* Open PDF button — shown when page info exists and PDF is accessible */}
        {canOpenPdf && (
          <TouchableOpacity
            onPress={() => onOpenPdf(chunk.source, chunk.page != null ? chunk.page : 1, chunk.bbox || null)}
          >
            <Text style={styles.openBtn}>Open in manual →</Text>
          </TouchableOpacity>
        )}

        {/* Hint when in deep_offline and PDF not yet synced */}
        {isDeepOffline && chunk.source && !pdfAvailable && (
          <Text style={styles.pdfHint}>PDF not synced</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg3, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: spacing.sm,
  },
  header:     { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.xs },
  icon:       { fontSize: 12, color: colors.text2 },
  source:     { flex: 1, fontSize: 11, color: colors.teal, fontFamily: 'Courier New' },
  scoreDot:   { width: 6, height: 6, borderRadius: 3 },
  breadcrumb: { fontSize: 10, color: colors.accentText, fontFamily: 'Courier New', marginBottom: spacing.xs },
  barTrack:   { height: 2, backgroundColor: colors.bg4, borderRadius: 1, marginBottom: spacing.sm, overflow: 'hidden' },
  barFill:    { height: '100%', borderRadius: 1 },
  content:    { fontSize: 13, color: colors.text1, lineHeight: 20 },
  footer:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.sm },
  footerBtn:  { fontSize: 11, color: colors.text3 },
  openBtn:    { fontSize: 11, color: colors.accent },
  pdfHint:    { fontSize: 10, color: colors.text3, fontFamily: 'Courier New', fontStyle: 'italic' },
});