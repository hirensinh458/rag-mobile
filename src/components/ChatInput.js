// src/components/ChatInput.js
import React, { useState, useRef } from 'react';
import {
  View, TextInput, TouchableOpacity,
  Text, StyleSheet, ActivityIndicator,
} from 'react-native';
import { colors, spacing, radius, typography, minTapTarget } from '../config/theme';

const PLACEHOLDER = {
  full_online:   'Ask about the manual…',
  intranet_only: 'Search manual sections…',
  deep_offline:  'Search local database…',
};

const MODE_LABEL = {
  full_online:   { text: '● AI-powered response',        color: colors.online },
  intranet_only: { text: '● Manual section search only', color: colors.intranet },
  deep_offline:  { text: '● Local database search',      color: colors.offline },
};

/**
 * Props:
 *   onSend     fn(text)  — called when user submits
 *   disabled   boolean   — disables input while streaming
 *   mode       string    — 'full_online' | 'intranet_only' | 'deep_offline'
 *   statusText string    — optional status shown above the input
 */
export function ChatInput({ onSend, disabled = false, mode = 'full_online', statusText = '' }) {
  const [text, setText] = useState('');
  const inputRef = useRef(null);

  const canSend   = text.trim().length > 0 && !disabled;
  const modeInfo  = MODE_LABEL[mode] || MODE_LABEL.full_online;
  const modeColor = modeInfo.color;

  const handleSend = () => {
    if (!canSend) return;
    const q = text.trim();
    setText('');
    onSend(q);
  };

  return (
    <View style={styles.wrapper}>

      {/* Status / streaming indicator */}
      {(statusText || disabled) ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />
          <Text style={styles.statusText} numberOfLines={1}>
            {statusText || (mode === 'full_online' ? 'Generating…' : 'Searching…')}
          </Text>
        </View>
      ) : null}

      {/* Input row */}
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={PLACEHOLDER[mode] || PLACEHOLDER.full_online}
          placeholderTextColor={colors.text3}
          multiline
          maxLength={2000}
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={handleSend}
          editable={!disabled}
          autoCorrect
          autoCapitalize="sentences"
          keyboardShouldPersistTaps="handled"
        />

        <TouchableOpacity
          style={[
            styles.sendBtn,
            { backgroundColor: canSend ? modeColor : colors.bg5 },
          ]}
          onPress={handleSend}
          disabled={!canSend}
          activeOpacity={0.75}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={[styles.sendIcon, { color: canSend ? '#fff' : colors.text3 }]}>
            ↑
          </Text>
        </TouchableOpacity>
      </View>

      {/* Mode indicator strip */}
      <Text style={[styles.modeLabel, { color: modeColor + 'AA' }]}>
        {modeInfo.text}
      </Text>

    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor:   colors.bg1,
    borderTopWidth:    1,
    borderTopColor:    colors.border,
    paddingTop:        spacing.sm,
    paddingBottom:     spacing.md,
    paddingHorizontal: spacing.md,
  },
  statusRow: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: spacing.sm,
    paddingBottom:     spacing.xs,
    minHeight:         24,
  },
  spinner:    { marginRight: spacing.sm },
  statusText: {
    flex:       1,
    fontSize:   typography.fontSize.sm,
    color:      colors.accentText,
    fontFamily: typography.fontMono,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems:    'flex-end',
    gap:           spacing.sm,
  },
  input: {
    flex:              1,
    backgroundColor:   colors.bg4,
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       colors.borderMd,
    paddingHorizontal: spacing.md,
    paddingTop:        12,
    paddingBottom:     12,
    color:             colors.text0,
    fontSize:          typography.fontSize.md,
    lineHeight:        typography.fontSize.md * 1.45,
    maxHeight:         120,
    minHeight:         minTapTarget,
  },
  sendBtn: {
    width:          minTapTarget,
    height:         minTapTarget,
    borderRadius:   radius.full,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  sendIcon:  { fontSize: 22, fontWeight: '700' },
  modeLabel: {
    marginTop:  spacing.xs,
    paddingLeft: spacing.sm,
    fontSize:   typography.fontSize.xs,
    fontFamily: typography.fontMono,
  },
});