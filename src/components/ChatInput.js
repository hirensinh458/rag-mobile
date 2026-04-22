// src/components/ChatInput.js
//
// CHANGE: Accepts `mode` (NetworkMode enum) instead of `isOnline` boolean.
// Placeholder text and bottom label reflect the current mode.

import React, { useState }       from 'react';
import {
  View, TextInput, TouchableOpacity,
  Text, StyleSheet, ActivityIndicator,
} from 'react-native';
import { NetworkMode }           from '../hooks/useNetwork';
import { colors, spacing, radius, typography } from '../config/theme';

const PLACEHOLDER = {
  [NetworkMode.ONLINE]:       'Ask anything about the manual…',
  [NetworkMode.LAN_ONLY]:     'Search manual sections (no AI)…',
  [NetworkMode.DEEP_OFFLINE]: 'Search local database…',
};

const MODE_LABEL = {
  [NetworkMode.ONLINE]:       '● online · AI-powered',
  [NetworkMode.LAN_ONLY]:     '◑ LAN · retrieval only',
  [NetworkMode.DEEP_OFFLINE]: '○ offline · local database',
};

const MODE_LABEL_COLOR = {
  [NetworkMode.ONLINE]:       colors.text3,
  [NetworkMode.LAN_ONLY]:     colors.accentText,
  [NetworkMode.DEEP_OFFLINE]: colors.error,
};

export function ChatInput({ onSend, disabled, mode = NetworkMode.ONLINE, statusText }) {
  const [text, setText] = useState('');

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <View style={styles.wrapper}>
      {/* Status row — shown while streaming / searching */}
      {statusText ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.statusText}>{statusText}</Text>
        </View>
      ) : null}

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={PLACEHOLDER[mode]}
          placeholderTextColor={colors.text3}
          multiline
          maxLength={500}
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!text.trim() || disabled) && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!text.trim() || disabled}
        >
          <Text style={styles.sendIcon}>↑</Text>
        </TouchableOpacity>
      </View>

      {/* Mode label — bottom of input area */}
      <Text style={[styles.modeLabel, { color: MODE_LABEL_COLOR[mode] }]}>
        {MODE_LABEL[mode]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor:   colors.bg2,
    borderTopWidth:    1,
    borderTopColor:    colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop:        spacing.sm,
    paddingBottom:     spacing.lg,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    marginBottom:  spacing.xs,
  },
  statusText: { color: colors.text2, fontSize: typography.fontSize.sm },
  row:        { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex:              1,
    backgroundColor:   colors.bg3,
    borderWidth:       1,
    borderColor:       colors.border,
    borderRadius:      radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    color:             colors.text0,
    fontSize:          typography.fontSize.md,
    maxHeight:         120,
  },
  sendBtn: {
    width:           40,
    height:          40,
    borderRadius:    radius.full,
    backgroundColor: colors.accent,
    alignItems:      'center',
    justifyContent:  'center',
  },
  sendBtnDisabled: { backgroundColor: colors.bg4 },
  sendIcon:        { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  modeLabel: {
    marginTop:  spacing.xs,
    fontSize:   typography.fontSize.xs,
    fontFamily: 'Courier New',
  },
});