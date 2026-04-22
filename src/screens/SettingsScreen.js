import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchHealth } from '../api/kb';
import { colors, spacing, radius, typography } from '../config/theme';

export function SettingsScreen() {
  const [serverUrl, setServerUrl] = useState('');
  const [health,    setHealth]    = useState(null);
  const [checking,  setChecking]  = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('server_url').then(v => { if (v) setServerUrl(v); });
  }, []);

  const saveUrl = async () => {
    await AsyncStorage.setItem('server_url', serverUrl);
  };

  const checkHealth = async () => {
    setChecking(true);
    try {
      const h = await fetchHealth();
      setHealth(h);
    } catch (e) {
      setHealth({ error: e.message });
    } finally {
      setChecking(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Settings</Text>

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="http://10.0.2.2:8000"
        placeholderTextColor={colors.text3}
        autoCapitalize="none"
        keyboardType="url"
      />
      <TouchableOpacity style={styles.btn} onPress={saveUrl}>
        <Text style={styles.btnText}>Save</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={checkHealth}>
        <Text style={styles.btnText}>{checking ? 'Checking…' : 'Check Server Health'}</Text>
      </TouchableOpacity>

      {health && (
        <View style={styles.healthBox}>
          <Text style={styles.healthText}>{JSON.stringify(health, null, 2)}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg1 },
  content:   { padding: spacing.lg },
  heading:   { fontSize: typography.fontSize.xl, color: colors.text0,
               fontWeight: '600', marginBottom: spacing.xl },
  label:     { fontSize: typography.fontSize.sm, color: colors.text2, marginBottom: spacing.xs },
  input:     { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.border,
               borderRadius: radius.md, padding: spacing.md, color: colors.text0,
               fontSize: typography.fontSize.md, marginBottom: spacing.md },
  btn:       { backgroundColor: colors.accent, borderRadius: radius.md,
               padding: spacing.md, alignItems: 'center', marginBottom: spacing.sm },
  btnSecondary: { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.border },
  btnText:   { color: '#fff', fontWeight: '600' },
  healthBox: { backgroundColor: colors.bg3, borderRadius: radius.md, padding: spacing.md,
               marginTop: spacing.md },
  healthText:{ color: colors.teal, fontFamily: 'Courier New', fontSize: typography.fontSize.sm },
});