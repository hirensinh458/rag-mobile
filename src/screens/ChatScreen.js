// src/screens/ChatScreen.js
import React, { useRef, useCallback, useState, useEffect } from 'react';
import {
  View, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform,
  Text, TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChat }       from '../hooks/useChat';
import { useNetwork }    from '../hooks/useNetwork';
import { MessageBubble } from '../components/MessageBubble';
import { NetworkBanner } from '../components/NetworkBanner';
import { ChatInput }     from '../components/ChatInput';
import { PdfViewer }     from '../components/PdfViewer';
import { colors, spacing, typography, radius, minTapTarget } from '../config/theme';

const MODE_CONFIG = {
  full_online:   { label: 'ONLINE',     dot: colors.online },
  intranet_only: { label: 'AT SEA',     dot: colors.intranet },
  deep_offline:  { label: 'LOCAL ONLY', dot: colors.offline },
};

export function ChatScreen() {
  const { messages, streaming, statusText, send, clear } = useChat();
  const { serverReachable, serverHasInternet, mode }      = useNetwork();
  const flatListRef = useRef(null);
  const insets      = useSafeAreaInsets();

  // PDF viewer state lifted here so any chunk card can trigger it
  const [pdfViewer, setPdfViewer] = useState(null);

  const modeConf = MODE_CONFIG[mode] || MODE_CONFIG.full_online;

  // ── Auto-scroll on new message ──────────────────────────────────────────
  useEffect(() => {
    if (messages.length > 0) {
      const t = setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 80);
      return () => clearTimeout(t);
    }
  }, [messages.length]);

  useEffect(() => {
    if (streaming) {
      flatListRef.current?.scrollToEnd({ animated: false });
    }
  }, [messages, streaming]);

  // ── Callbacks ────────────────────────────────────────────────────────────
  const handleOpenPdf = useCallback((source, page, bbox) => {
    setPdfViewer({ filename: source, page: page || 1, bbox: bbox || null });
  }, []);

  const keyExtractor = useCallback((m) => String(m.id), []);

  const renderItem = useCallback(({ item }) => (
    <MessageBubble message={item} onOpenPdf={handleOpenPdf} />
  ), [handleOpenPdf]);

  return (
    <View style={styles.root}>

      {/* ── Status banner (slides in when not fully online) ── */}
      <NetworkBanner
        serverReachable={serverReachable}
        serverHasInternet={serverHasInternet}
      />

      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>MarineDoc</Text>
          <Text style={styles.subtitle}>Ship Manual Assistant</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.modeBadge, { borderColor: modeConf.dot + '55' }]}>
            <View style={[styles.modeDot, { backgroundColor: modeConf.dot }]} />
            <Text style={[styles.modeLabel, { color: modeConf.dot }]}>
              {modeConf.label}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={clear}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.clearBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/*
       * KeyboardAvoidingView wraps BOTH the FlatList and ChatInput.
       * This is the correct pattern — if it only wraps the input,
       * the keyboard covers the last message.
       *
       * iOS:     'padding' — pushes everything up by keyboard height
       * Android: 'height'  — shrinks the view height (requires
       *          android:windowSoftInputMode="adjustResize" in manifest,
       *          which is already set in your AndroidManifest.xml)
       */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* ── Message list ── */}
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[
            styles.listContent,
            messages.length === 0 && styles.listFlex,
          ]}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          removeClippedSubviews={false}
          ListEmptyComponent={<EmptyState mode={mode} />}
        />

        {/* ── Input (always above keyboard because it's inside KAV) ── */}
        <ChatInput
          onSend={(text) => send(text, mode)}
          disabled={streaming}
          mode={mode}
          statusText={statusText}
        />
      </KeyboardAvoidingView>

      {/* PDF viewer rendered outside KAV so it's truly fullscreen */}
      {pdfViewer && (
        <PdfViewer
          filename={pdfViewer.filename}
          page={pdfViewer.page}
          bbox={pdfViewer.bbox}
          onClose={() => setPdfViewer(null)}
        />
      )}
    </View>
  );
}

function EmptyState({ mode }) {
  const content = {
    full_online:   { icon: '◈', title: 'Ask anything about the ship manual', hint: 'AI-powered answers with citations' },
    intranet_only: { icon: '⚓', title: 'At sea — retrieval mode active',     hint: 'Returns manual sections, no AI generation' },
    deep_offline:  { icon: '📵', title: 'Server unreachable',                 hint: 'Searching local database only' },
  }[mode] || { icon: '◈', title: 'Ask anything', hint: '' };

  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyIcon}>{content.icon}</Text>
      <Text style={styles.emptyTitle}>{content.title}</Text>
      {content.hint ? <Text style={styles.emptyHint}>{content.hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root:  { flex: 1, backgroundColor: colors.bg0 },
  flex:  { flex: 1 },

  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop:        spacing.md,
    paddingBottom:     spacing.md,
    backgroundColor:   colors.bg1,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize:     typography.fontSize.xl,
    color:        colors.text0,
    fontWeight:   '700',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize:   typography.fontSize.xs,
    color:      colors.text3,
    fontFamily: typography.fontMono,
    marginTop:  2,
  },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  modeBadge:   {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               5,
    borderWidth:       1,
    borderRadius:      radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical:   4,
  },
  modeDot:  { width: 6, height: 6, borderRadius: 3 },
  modeLabel:{
    fontSize:     typography.fontSize.xs,
    fontFamily:   typography.fontMono,
    letterSpacing: 0.7,
    fontWeight:   '600',
  },
  clearBtn: {
    width:          32,
    height:         32,
    borderRadius:   radius.full,
    backgroundColor: colors.bg3,
    alignItems:     'center',
    justifyContent: 'center',
    borderWidth:    1,
    borderColor:    colors.border,
  },
  clearBtnText: { color: colors.text2, fontSize: 14 },

  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop:        spacing.md,
    paddingBottom:     spacing.xl,
  },
  listFlex: { flex: 1 },

  emptyWrap: {
    flex:              1,
    alignItems:        'center',
    justifyContent:    'center',
    paddingTop:        60,
    paddingHorizontal: spacing.xxl,
  },
  emptyIcon:  { fontSize: 40, color: colors.text3, marginBottom: spacing.md },
  emptyTitle: {
    fontSize:   typography.fontSize.lg,
    color:      colors.text2,
    textAlign:  'center',
    fontWeight: '500',
  },
  emptyHint: {
    fontSize:   typography.fontSize.sm,
    color:      colors.text3,
    textAlign:  'center',
    marginTop:  spacing.xs,
    fontFamily: typography.fontMono,
  },
});