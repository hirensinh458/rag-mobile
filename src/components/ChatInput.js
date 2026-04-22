import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, spacing, radius, typography } from '../config/theme';

export function ChatInput({ onSend, disabled, isOnline, statusText }) {
  const [text, setText] = useState('');

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <View style={styles.wrapper}>
      {/* Status text (searching / streaming indicator) */}
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
          placeholder={isOnline ? 'Ask about the manual…' : 'Search manual sections…'}
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

      {/* Online / offline mode indicator */}
      <Text style={styles.modeLabel}>
        {isOnline ? '● online · AI-powered' : '○ offline · retrieval only'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: colors.bg2,
    borderTopWidth:  1,
    borderTopColor:  colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop:      spacing.sm,
    paddingBottom:   spacing.lg,
  },
  statusRow: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.sm,
    marginBottom:   spacing.xs,
  },
  statusText: { color: colors.text2, fontSize: typography.fontSize.sm },
  row:        { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex:            1,
    backgroundColor: colors.bg3,
    borderWidth:     1,
    borderColor:     colors.border,
    borderRadius:    radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color:           colors.text0,
    fontSize:        typography.fontSize.md,
    maxHeight:       120,
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
    color:      colors.text3,
    fontFamily: 'Courier New',
  },
});