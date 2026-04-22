// src/screens/ChatScreen.js
//
// CHANGES:
//   - Uses NetworkMode enum instead of boolean effectivelyOnline
//   - Passes mode (not boolean) to send() and ChatInput
//   - ModeSubtitle shows three distinct states with color coding

import React, { useRef }                   from 'react';
import {
  View, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Text,
} from 'react-native';
import { useChat }        from '../hooks/useChat';
import { useNetwork, NetworkMode } from '../hooks/useNetwork';
import { MessageBubble }  from '../components/MessageBubble';
import { NetworkBanner }  from '../components/NetworkBanner';
import { ChatInput }      from '../components/ChatInput';
import { colors, spacing, typography } from '../config/theme';

// ── Per-mode subtitle config ───────────────────────────────────────
const SUBTITLE = {
  [NetworkMode.ONLINE]:       { text: '● Connected · AI-powered',           color: colors.teal },
  [NetworkMode.LAN_ONLY]:     { text: '◑ LAN only · retrieval mode',        color: colors.accentText },
  [NetworkMode.DEEP_OFFLINE]: { text: '○ Offline · local database',         color: colors.error },
};

export function ChatScreen() {
  const { messages, streaming, statusText, send, clear } = useChat();
  const { mode }                                         = useNetwork();
  const flatListRef = useRef(null);

  return (
    <View style={styles.container}>
      {/* Animated mode banner — hidden when ONLINE */}
      <NetworkBanner mode={mode} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>RAG Assistant</Text>
        <Text style={[styles.subtitle, { color: SUBTITLE[mode].color }]}>
          {SUBTITLE[mode].text}
        </Text>
      </View>

      {/* Message list */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={m => String(m.id)}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>◈</Text>
            <Text style={styles.emptyText}>Ask anything about the manual</Text>
          </View>
        }
      />

      {/* Input */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ChatInput
          onSend={(text) => send(text, mode)} // pass mode enum, not boolean
          disabled={streaming}
          mode={mode}
          statusText={statusText}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg1 },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop:        spacing.xl,
    paddingBottom:     spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title:    { fontSize: typography.fontSize.xl, color: colors.text0, fontWeight: '600' },
  subtitle: { fontSize: typography.fontSize.sm, fontFamily: 'Courier New', marginTop: 2 },
  list:     { paddingHorizontal: spacing.md, paddingVertical: spacing.lg, flexGrow: 1 },
  empty:    { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyIcon:{ fontSize: 32, color: colors.text3, marginBottom: spacing.md },
  emptyText:{ fontSize: typography.fontSize.md, color: colors.text3 },
});