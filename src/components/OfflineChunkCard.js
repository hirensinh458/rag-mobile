import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, radius, typography } from '../config/theme';

const TYPE_ICON = { image: '🖼', table: '⊞', text: '◈', heading: '◈' };

export function OfflineChunkCard({ chunk, onOpenPdf }) {
  const [expanded, setExpanded] = useState(false);

  const icon     = TYPE_ICON[chunk.chunk_type] || '◈';
  const scorePct = Math.min(100, Math.max(0, (chunk.score || 0) * 100));
  const scoreColor = scorePct > 65 ? '#34d399' : scorePct > 35 ? '#fbbf24' : '#94a3b8';

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.icon}>{icon}</Text>
        <Text style={styles.source} numberOfLines={1}>
          {chunk.source}{chunk.page ? ` · p${chunk.page}` : ''}
        </Text>
        <View style={[styles.scoreDot, { backgroundColor: scoreColor }]} />
      </View>

      {/* Section breadcrumb */}
      {chunk.section_path ? (
        <Text style={styles.breadcrumb} numberOfLines={1}>{chunk.section_path}</Text>
      ) : null}

      {/* Score bar */}
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${scorePct}%`, backgroundColor: scoreColor }]} />
      </View>

      {/* Content */}
      <Text style={styles.content} numberOfLines={expanded ? undefined : 4}>
        {chunk.content}
      </Text>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity onPress={() => setExpanded(e => !e)}>
          <Text style={styles.footerBtn}>{expanded ? 'Show less ↑' : 'Show more ↓'}</Text>
        </TouchableOpacity>
        {chunk.source && chunk.page && onOpenPdf && (
          <TouchableOpacity onPress={() => onOpenPdf(chunk.source, chunk.page, chunk.bbox)}>
            <Text style={styles.openBtn}>Open in manual →</Text>
          </TouchableOpacity>
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
  footer:     { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  footerBtn:  { fontSize: 11, color: colors.text3 },
  openBtn:    { fontSize: 11, color: colors.accent },
});