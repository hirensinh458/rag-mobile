// src/components/MessageBubble.js
//
// CHANGES:
//   - Citation chips are now <TouchableOpacity> elements that call onOpenPdf
//     (previously they were static <View>/<Text> chips with no interaction)
//   - Page guard changed from `c.page && ...` to `c.page != null && ...`
//     to handle page === 0 correctly (avoids "Text in View" crash)
//   - onOpenPdf is called with (source, page, bbox) — bbox from enriched citations

import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { OfflineChunkCard } from './OfflineChunkCard';
import { colors, spacing, radius, typography } from '../config/theme';

const markdownStyles = {
  body:        { color: colors.text1, fontSize: typography.fontSize.md, lineHeight: 23 },
  code_block:  { backgroundColor: colors.bg3, padding: spacing.sm, borderRadius: radius.sm },
  code_inline: { backgroundColor: colors.bg3, color: colors.teal, fontFamily: typography.fontMono },
  heading1:    { color: colors.text0, fontSize: typography.fontSize.xl, fontWeight: '700' },
  heading2:    { color: colors.text0, fontSize: typography.fontSize.lg, fontWeight: '600' },
  heading3:    { color: colors.text0, fontSize: typography.fontSize.md, fontWeight: '600' },
  strong:      { color: colors.text0, fontWeight: '600' },
  em:          { color: colors.text2, fontStyle: 'italic' },
  bullet_list: { color: colors.text1 },
  list_item:   { color: colors.text1, marginBottom: 2 },
  table:       { borderWidth: 1, borderColor: colors.border },
  th:          { backgroundColor: colors.bg3, padding: 6, color: colors.accentText },
  td:          { padding: 6, color: colors.text1, borderTopWidth: 1, borderColor: colors.border },
  blockquote:  {
    borderLeftWidth: 2, borderLeftColor: colors.accentDim,
    paddingLeft: 10, marginLeft: 0, backgroundColor: colors.bg3,
  },
};

/**
 * Tappable citation chips — each chip opens the PDF viewer at the cited page.
 *
 * Critical: use `c.page != null` not `c.page` — page can be 0 (falsy) and
 * rendering raw numeric 0 outside <Text> crashes React Native.
 */
function CitationChips({ citations, onOpenPdf }) {
  if (!citations || citations.length === 0) return null;

  return (
    <View style={chipStyles.row}>
      {citations.map((c, i) => (
        <TouchableOpacity
          key={i}
          style={chipStyles.chip}
          onPress={() => onOpenPdf && onOpenPdf(c.source, c.page != null ? c.page : 1, c.bbox || null)}
          activeOpacity={0.7}
        >
          <Text style={chipStyles.icon}>📄</Text>
          <View style={chipStyles.info}>
            <Text style={chipStyles.filename} numberOfLines={1}>
              {c.source}
            </Text>
            {c.page != null && (
              <Text style={chipStyles.page}>
                {'p. ' + c.page}
                {c.heading ? '  ·  ' + c.heading : ''}
              </Text>
            )}
          </View>
          <Text style={chipStyles.arrow}>›</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const chipStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           spacing.xs,
    marginTop:     spacing.md,
  },
  chip: {
    flexDirection:     'row',
    alignItems:        'center',
    backgroundColor:   colors.bg3,
    borderRadius:      radius.md,
    borderWidth:       1,
    borderColor:       colors.borderMd,
    paddingHorizontal: spacing.sm,
    paddingVertical:   6,
    gap:               spacing.xs,
    maxWidth:          '100%',
  },
  icon:     { fontSize: 12 },
  info:     { flex: 1, minWidth: 0 },
  filename: {
    color:      colors.teal,
    fontSize:   typography.fontSize.xs,
    fontFamily: typography.fontMono,
  },
  page: {
    color:      colors.text3,
    fontSize:   typography.fontSize.xs,
    fontFamily: typography.fontMono,
    marginTop:  1,
  },
  arrow: {
    color:    colors.accentText,
    fontSize: 16,
    fontWeight: '600',
  },
});

/**
 * Props:
 *   message   object  — message from useChat
 *   onOpenPdf fn      — (source, page, bbox) => void — wired from ChatScreen
 */
export function MessageBubble({ message, onOpenPdf }) {
  const isUser = message.role === 'user';

  // ── User bubble ──────────────────────────────────────────────────────────
  if (isUser) {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userLabel}>YOU</Text>
          <Text style={styles.userText}>{message.content}</Text>
        </View>
      </View>
    );
  }

  // ── Offline: chunk cards ─────────────────────────────────────────────────
  if (message.is_offline) {
    const chunks = message.offline_chunks || [];
    return (
      <View style={styles.assistantRow}>
        <View style={styles.assistantBubble}>
          <View style={styles.offlineHeader}>
            <Text style={styles.offlineLabel}>◈  RETRIEVED SECTIONS</Text>
            {chunks.length > 0 && (
              <View style={styles.countBadge}>
                <Text style={styles.countText}>{chunks.length}</Text>
              </View>
            )}
          </View>

          {chunks.length === 0 && !message.isError && (
            <Text style={styles.emptyText}>No matching sections found.</Text>
          )}
          {message.isError && (
            <Text style={styles.errorText}>{message.content}</Text>
          )}

          {chunks.map((chunk, i) => (
            <OfflineChunkCard
              key={chunk.id || i}
              chunk={chunk}
              onOpenPdf={onOpenPdf}
            />
          ))}
        </View>
      </View>
    );
  }

  // ── Online: streaming markdown ───────────────────────────────────────────
  return (
    <View style={styles.assistantRow}>
      <View style={styles.assistantBubble}>
        <Text style={styles.assistantLabel}>MARINEDOC</Text>

        {message.content ? (
          <>
            <Markdown style={markdownStyles}>{message.content}</Markdown>
            {message.streaming && <Text style={styles.cursor}>▊</Text>}
          </>
        ) : (
          <ActivityIndicator size="small" color={colors.accent} />
        )}

        {/* Tappable citation chips — open PDF viewer at cited page */}
        {!message.streaming && (message.citations || []).length > 0 && (
          <CitationChips citations={message.citations} onOpenPdf={onOpenPdf} />
        )}

        {/* Token count */}
        {!message.streaming && message.usage?.total_tokens && (
          <Text style={styles.tokenCount}>
            {message.usage.total_tokens.toLocaleString()} tokens
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // User
  userRow:    { alignItems: 'flex-end', marginVertical: spacing.xs },
  userBubble: {
    backgroundColor:    '#1e1b3a',
    borderRadius:       radius.lg,
    borderTopRightRadius: radius.sm,
    borderWidth:        1,
    borderColor:        'rgba(124,106,247,0.22)',
    paddingHorizontal:  spacing.md,
    paddingVertical:    spacing.sm,
    maxWidth:           '82%',
  },
  userLabel: {
    fontSize:     typography.fontSize.xs,
    color:        colors.accentDim,
    fontFamily:   typography.fontMono,
    letterSpacing: 0.8,
    marginBottom:  5,
  },
  userText: { color: colors.text0, fontSize: typography.fontSize.md, lineHeight: 22 },

  // Assistant
  assistantRow: { alignItems: 'flex-start', marginVertical: spacing.xs },
  assistantBubble: {
    backgroundColor:    colors.bg2,
    borderRadius:       radius.lg,
    borderTopLeftRadius: radius.sm,
    borderWidth:        1,
    borderColor:        colors.borderMd,
    paddingHorizontal:  spacing.md,
    paddingVertical:    spacing.md,
    maxWidth:           '95%',
    width:              '95%',
  },
  assistantLabel: {
    fontSize:     typography.fontSize.xs,
    color:        colors.accentText,
    fontFamily:   typography.fontMono,
    letterSpacing: 0.8,
    marginBottom:  8,
  },
  cursor: { color: colors.accent, fontSize: 14, marginTop: 2 },

  // Offline header
  offlineHeader: {
    flexDirection: 'row', alignItems: 'center',
    marginBottom:  spacing.md, gap: spacing.sm,
  },
  offlineLabel: {
    fontSize:     typography.fontSize.xs,
    color:        colors.text2,
    fontFamily:   typography.fontMono,
    letterSpacing: 0.8,
    flex:          1,
  },
  countBadge: {
    backgroundColor:   colors.bg4,
    borderRadius:      radius.full,
    paddingHorizontal: 8,
    paddingVertical:   2,
    borderWidth:       1,
    borderColor:       colors.border,
  },
  countText: {
    fontSize:   typography.fontSize.xs,
    color:      colors.teal,
    fontFamily: typography.fontMono,
  },

  emptyText: { color: colors.text3, fontSize: typography.fontSize.sm, paddingVertical: spacing.sm },
  errorText: { color: colors.error, fontSize: typography.fontSize.sm, paddingVertical: spacing.sm },

  tokenCount: {
    marginTop:  spacing.sm,
    textAlign:  'right',
    fontSize:   typography.fontSize.xs,
    color:      colors.text3,
    fontFamily: typography.fontMono,
  },
});