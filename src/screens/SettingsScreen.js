// src/screens/SettingsScreen.js
import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchHealth, fetchStats } from '../api/kb';
import { getChunkCount } from '../offline/db';
import { colors, spacing, radius, typography, minTapTarget } from '../config/theme';

export function SettingsScreen() {
  const [serverUrl,    setServerUrl]    = useState('');
  const [health,       setHealth]       = useState(null);
  const [stats,        setStats]        = useState(null);
  const [chunkCount,   setChunkCount]   = useState(null);
  const [checking,     setChecking]     = useState(false);
  const [saveFeedback, setSaveFeedback] = useState('');

  useEffect(() => {
    AsyncStorage.getItem('server_url').then(v => { if (v) setServerUrl(v); });
    getChunkCount().then(setChunkCount).catch(() => setChunkCount(0));
  }, []);

  const saveUrl = async () => {
    await AsyncStorage.setItem('server_url', serverUrl.trim());
    setSaveFeedback('Saved ✓');
    setTimeout(() => setSaveFeedback(''), 2000);
  };

  const checkHealth = async () => {
    setChecking(true);
    setHealth(null);
    setStats(null);
    try {
      const [h, s] = await Promise.all([
        fetchHealth(),
        fetchStats().catch(() => null),
      ]);
      setHealth(h);
      setStats(s);
    } catch (e) {
      setHealth({ error: e.message });
    } finally {
      setChecking(false);
    }
  };

  const healthColor =
    !health          ? colors.text3 :
    health.error     ? colors.error :
    health.is_online ? colors.online :
                       colors.intranet;

  const healthLabel =
    !health          ? '—' :
    health.error     ? `Error: ${health.error}` :
    health.is_online ? 'Online — Groq available' :
                       'Server up — no internet (at-sea mode)';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>Settings</Text>

      {/* ── Server URL ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Server URL</Text>
        <Text style={styles.cardHint}>
          IP address of the FastAPI backend on your LAN.{'\n'}
          Android emulator: http://10.0.2.2:8000
        </Text>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="http://192.168.1.10:8000"
          placeholderTextColor={colors.text3}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TouchableOpacity style={styles.btn} onPress={saveUrl} activeOpacity={0.8}>
          <Text style={styles.btnText}>{saveFeedback || 'Save URL'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Server Health ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Server Status</Text>
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary]}
          onPress={checkHealth}
          disabled={checking}
          activeOpacity={0.8}
        >
          {checking
            ? <ActivityIndicator size="small" color={colors.accent} />
            : <Text style={styles.btnTextSecondary}>Check Server Health</Text>
          }
        </TouchableOpacity>

        {health && (
          <View style={styles.healthRow}>
            <View style={[styles.healthDot, { backgroundColor: healthColor }]} />
            <Text style={[styles.healthLabel, { color: healthColor }]}>{healthLabel}</Text>
          </View>
        )}

        {stats && (
          <View style={styles.statGrid}>
            <StatRow label="Vectors indexed" value={stats.total_vectors?.toLocaleString() || '0'} />
            <StatRow label="BM25 documents"  value={stats.bm25_docs?.toLocaleString()     || '0'} />
            <StatRow label="Embedding model" value={stats.embedding_model                 || '—'} />
            <StatRow label="LLM model"       value={stats.llm_model                       || '—'} />
          </View>
        )}
      </View>

      {/* ── Local Database ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Local Database</Text>
        <View style={styles.statGrid}>
          <StatRow
            label="Cached chunks"
            value={chunkCount === null ? '…' : chunkCount.toLocaleString()}
          />
        </View>
        <Text style={styles.cardHint}>
          Synced from server when reachable.
          Powers local search in deep-offline mode.
        </Text>
      </View>

      {/* ── About ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>About</Text>
        <Text style={styles.aboutText}>
          MarineDoc v1.0  ·  Hybrid RAG Ship Manual Assistant{'\n\n'}
          Mode 1 — Online: AI-powered answers (Groq){'\n'}
          Mode 2 — At Sea: Manual section retrieval{'\n'}
          Mode 3 — Offline: Local SQLite full-text search
        </Text>
      </View>
    </ScrollView>
  );
}

function StatRow({ label, value }) {
  return (
    <View style={statStyles.row}>
      <Text style={statStyles.label}>{label}</Text>
      <Text style={statStyles.value}>{value}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  row:   {
    flexDirection:   'row',
    justifyContent:  'space-between',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  label: { fontSize: typography.fontSize.sm, color: colors.text2 },
  value: { fontSize: typography.fontSize.sm, color: colors.teal, fontFamily: typography.fontMono },
});

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: colors.bg0 },
  content: { padding: spacing.lg, paddingBottom: 60 },
  heading: {
    fontSize:     typography.fontSize.xxl,
    color:        colors.text0,
    fontWeight:   '700',
    marginBottom: spacing.xl,
    letterSpacing: -0.5,
  },
  card: {
    backgroundColor: colors.bg2,
    borderRadius:    radius.lg,
    borderWidth:     1,
    borderColor:     colors.border,
    padding:         spacing.lg,
    marginBottom:    spacing.lg,
    gap:             spacing.md,
  },
  cardTitle: {
    fontSize:     typography.fontSize.lg,
    color:        colors.text0,
    fontWeight:   '600',
    marginBottom: spacing.xs,
  },
  cardHint: {
    fontSize:   typography.fontSize.sm,
    color:      colors.text3,
    lineHeight: 20,
  },
  input: {
    backgroundColor:   colors.bg4,
    borderWidth:       1,
    borderColor:       colors.borderMd,
    borderRadius:      radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   12,
    color:             colors.text0,
    fontSize:          typography.fontSize.md,
    minHeight:         minTapTarget,
    fontFamily:        typography.fontMono,
  },
  btn: {
    backgroundColor: colors.accent,
    borderRadius:    radius.md,
    paddingVertical: 12,
    alignItems:      'center',
    justifyContent:  'center',
    minHeight:       minTapTarget,
  },
  btnText:          { color: '#fff', fontWeight: '600', fontSize: typography.fontSize.md },
  btnSecondary:     { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.borderMd },
  btnTextSecondary: { color: colors.text1, fontWeight: '600', fontSize: typography.fontSize.md },

  healthRow:  { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.xs },
  healthDot:  { width: 8, height: 8, borderRadius: 4 },
  healthLabel:{ fontSize: typography.fontSize.sm, flex: 1, lineHeight: 20 },

  statGrid: { gap: 2 },

  aboutText: {
    fontSize:   typography.fontSize.sm,
    color:      colors.text2,
    lineHeight: 22,
    fontFamily: typography.fontMono,
  },
});