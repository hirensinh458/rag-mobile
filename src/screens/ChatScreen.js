// src/screens/ChatScreen.js
//
// SYNC FIX: useOfflineSearch removed from here — it now lives in AppNavigator
// and is shared via SyncContext. ChatScreen calls useSyncContext() to read
// syncStatus (for the "Syncing…" subtitle) without owning the hook.
//
// openSettings no longer needs to pass triggerSync as a nav param —
// SettingsScreen reads it directly from SyncContext.

import React, { useRef, useCallback, useState, useEffect } from 'react';
import {
  View, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform,
  Text, TouchableOpacity,
} from 'react-native';
import AsyncStorage          from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation }     from '@react-navigation/native';

import { useChat }        from '../hooks/useChat';
import { useNetwork }     from '../hooks/useNetwork';
import { useSyncContext }  from '../context/SyncContext';
import { MessageBubble }  from '../components/MessageBubble';
import { NetworkBanner }  from '../components/NetworkBanner';
import { ChatInput }      from '../components/ChatInput';
import { PdfViewer }      from '../components/PdfViewer';
import { Config }         from '../config';
import { colors, spacing, typography, radius, minTapTarget } from '../config/theme';

const MODE_CONFIG = {
  full_online:   { label: 'ONLINE',     dot: colors.online   },
  intranet_only: { label: 'AT SEA',     dot: colors.intranet },
  deep_offline:  { label: 'LOCAL ONLY', dot: colors.offline  },
};

export function ChatScreen() {
  const navigation = useNavigation();
  const { mode, activeUrl, serverReachable, serverHasInternet } = useNetwork();
  const { messages, streaming, statusText, send, clear }        = useChat(activeUrl);
  const { syncStatus }  = useSyncContext();   // read-only — hook lives in AppNavigator

  const flatListRef = useRef(null);
  const insets      = useSafeAreaInsets();

  const [pdfViewer, setPdfViewer] = useState(null);
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    (async () => {
      const cloud  = await AsyncStorage.getItem('cloud_url');
      const local  = await AsyncStorage.getItem('local_url');
      const legacy = await AsyncStorage.getItem('server_url');
      const resolved = activeUrl
        || (cloud  && cloud.trim())
        || (local  && local.trim())
        || (legacy && legacy.trim())
        || Config.API_BASE_URL;
      setServerUrl(resolved);
    })();
  }, [activeUrl]);

  // Simple navigate — no params needed, SettingsScreen uses SyncContext directly
  const openSettings = useCallback(() => {
    navigation.navigate('Settings');
  }, [navigation]);

  const modeConf = MODE_CONFIG[mode] || MODE_CONFIG.full_online;

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

  const handleOpenPdf = useCallback((source, page, bbox) => {
    setPdfViewer({ filename: source, page: page || 1, bbox: bbox || null });
  }, []);

  const keyExtractor = useCallback((m) => String(m.id), []);

  const renderItem = useCallback(({ item }) => (
    <MessageBubble message={item} onOpenPdf={handleOpenPdf} mode={mode} />
  ), [handleOpenPdf, mode]);

  return (
    <View style={styles.root}>

      <NetworkBanner
        serverReachable={serverReachable}
        serverHasInternet={serverHasInternet}
      />

      <View style={styles.header}>
        <View>
          <Text style={styles.title}>MarineDoc</Text>
          <Text style={styles.subtitle}>
            {syncStatus.isSyncing ? 'Syncing…' : 'Ship Manual Assistant'}
          </Text>
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
            onPress={openSettings}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.clearBtnText}>⚙</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={clear}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.clearBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
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

        <ChatInput
          onSend={(text) => send(text, mode)}
          disabled={streaming}
          mode={mode}
          statusText={statusText}
        />
      </KeyboardAvoidingView>

      {pdfViewer && (
        <PdfViewer
          filename={pdfViewer.filename}
          page={pdfViewer.page}
          bbox={pdfViewer.bbox}
          serverUrl={serverUrl}
          mode={mode}
          onClose={() => setPdfViewer(null)}
        />
      )}
    </View>
  );
}

function EmptyState({ mode }) {
  const content = {
    full_online:   { icon: '◈', title: 'Ask anything about the ship manual', hint: 'AI-powered answers with citations'  },
    intranet_only: { icon: '⚓', title: 'At sea — retrieval mode active',     hint: 'Returns manual sections, no AI generation' },
    deep_offline:  { icon: '📵', title: 'Server unreachable',                 hint: 'Searching local database only'     },
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
    fontSize:      typography.fontSize.xl,
    color:         colors.text0,
    fontWeight:    '700',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize:   typography.fontSize.xs,
    color:      colors.text3,
    fontFamily: typography.fontMono,
    marginTop:  2,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  modeBadge: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               5,
    borderWidth:       1,
    borderRadius:      radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical:   4,
  },
  modeDot:   { width: 6, height: 6, borderRadius: 3 },
  modeLabel: {
    fontSize:      typography.fontSize.xs,
    fontFamily:    typography.fontMono,
    letterSpacing: 0.7,
    fontWeight:    '600',
  },
  clearBtn: {
    width:           32,
    height:          32,
    borderRadius:    radius.full,
    backgroundColor: colors.bg3,
    alignItems:      'center',
    justifyContent:  'center',
    borderWidth:     1,
    borderColor:     colors.border,
  },
  clearBtnText: { color: colors.text2, fontSize: 14 },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop:        spacing.md,
    paddingBottom:     spacing.xl,
  },
  listFlex:   { flex: 1 },
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