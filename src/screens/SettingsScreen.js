// src/screens/SettingsScreen.js
//
// FINAL VERSION — adds sync controls and local database stats for Phase 2.
//   - "Sync now" button triggers syncFromServer()
//   - Shows: last synced timestamp, local chunk count, sync phase/error
//   - All previous changes preserved (mode dot, recheck, URL cache invalidation)

import React, { useState, useEffect }      from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import AsyncStorage                        from '@react-native-async-storage/async-storage';
import { useNetwork, NetworkMode }         from '../hooks/useNetwork';
import { useOfflineSearch }               from '../hooks/useOfflineSearch';
import { invalidateUrlCache }             from '../api/client';
import { colors, spacing, radius, typography } from '../config/theme';

// ─────────────────────────────────────────────────────────────
// MODE CONFIG
// ─────────────────────────────────────────────────────────────
const MODE_DISPLAY = {
  [NetworkMode.ONLINE]:       { label: 'Full online (Mode 1)',  dot: colors.teal },
  [NetworkMode.LAN_ONLY]:     { label: 'LAN only (Mode 2)',     dot: colors.accentText },
  [NetworkMode.DEEP_OFFLINE]: { label: 'Deep offline (Mode 3)', dot: colors.error },
};

const SYNC_PHASE_LABEL = {
  idle:        '',
  connecting:  'Connecting…',
  fetching:    'Downloading chunks…',
  storing:     'Saving to local DB…',
  done:        'Sync complete',
  error:       'Sync failed',
};

// ─────────────────────────────────────────────────────────────
// SCREEN
// ─────────────────────────────────────────────────────────────
export function SettingsScreen() {
  const [serverUrl, setServerUrl] = useState('');
  const [saved,     setSaved]     = useState(false);

  const { mode, checking, lastChecked, probe } = useNetwork();
  const { syncStatus, triggerSync }            = useOfflineSearch(mode);

  useEffect(() => {
    AsyncStorage.getItem('server_url').then(v => { if (v) setServerUrl(v); });
  }, []);

  const saveUrl = async () => {
    const trimmed = serverUrl.trim();
    await AsyncStorage.setItem('server_url', trimmed);
    invalidateUrlCache();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await probe();
  };

  const modeInfo       = MODE_DISPLAY[mode];
  const lastCheckedStr = lastChecked ? lastChecked.toLocaleTimeString() : '—';
  const lastSyncedStr  = syncStatus.lastSynced
    ? new Date(syncStatus.lastSynced).toLocaleString()
    : 'Never';

  const canSync = (mode === NetworkMode.ONLINE || mode === NetworkMode.LAN_ONLY)
               && !syncStatus.isSyncing;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Settings</Text>

      {/* ── Network Status ─────────────────────────────────── */}
      <Text style={styles.sectionLabel}>Network Status</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={[styles.dot, { backgroundColor: modeInfo.dot }]} />
          <Text style={styles.modeLabel}>{modeInfo.label}</Text>
          <TouchableOpacity
            style={styles.smallBtn}
            onPress={probe}
            disabled={checking}
          >
            <Text style={styles.smallBtnText}>
              {checking ? 'Checking…' : 'Recheck'}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.meta}>Last checked: {lastCheckedStr}</Text>
      </View>

      {/* ── Local Database ─────────────────────────────────── */}
      <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>
        Local Database
      </Text>
      <View style={styles.card}>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Chunks stored</Text>
          <Text style={styles.statValue}>{syncStatus.localCount.toLocaleString()}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Last synced</Text>
          <Text style={styles.statValue}>{lastSyncedStr}</Text>
        </View>

        {/* Sync status / progress */}
        {syncStatus.isSyncing && (
          <View style={styles.syncProgress}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.syncPhase}>
              {SYNC_PHASE_LABEL[syncStatus.phase] || 'Syncing…'}
            </Text>
          </View>
        )}

        {syncStatus.error && !syncStatus.isSyncing && (
          <Text style={styles.syncError}>⚠ {syncStatus.error}</Text>
        )}

        <TouchableOpacity
          style={[styles.syncBtn, !canSync && styles.syncBtnDisabled]}
          onPress={triggerSync}
          disabled={!canSync}
        >
          <Text style={styles.syncBtnText}>
            {syncStatus.isSyncing
              ? 'Syncing…'
              : mode === NetworkMode.DEEP_OFFLINE
                ? 'Connect to server to sync'
                : 'Sync now'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.meta}>
          Sync pulls all indexed documents to your device for offline use.
          Runs automatically when you reconnect after being offline.
        </Text>
      </View>

      {/* ── Server URL ─────────────────────────────────────── */}
      <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>Server URL</Text>
      <Text style={styles.hint}>
        LAN IP of the machine running FastAPI.{'\n'}
        Example: http://192.168.1.42:8000
      </Text>
      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="http://192.168.x.x:8000"
        placeholderTextColor={colors.text3}
        autoCapitalize="none"
        keyboardType="url"
        autoCorrect={false}
      />
      <TouchableOpacity style={styles.btn} onPress={saveUrl}>
        <Text style={styles.btnText}>{saved ? '✓ Saved' : 'Save & Recheck'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: colors.bg1 },
  content:     { padding: spacing.lg, paddingBottom: spacing.xxl },

  heading: {
    fontSize:     typography.fontSize.xl,
    color:        colors.text0,
    fontWeight:   '600',
    marginBottom: spacing.xl,
  },

  sectionLabel: {
    fontSize:      typography.fontSize.sm,
    color:         colors.text2,
    marginBottom:  spacing.sm,
    fontFamily:    'Courier New',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  card: {
    backgroundColor: colors.bg3,
    borderWidth:     1,
    borderColor:     colors.border,
    borderRadius:    radius.md,
    padding:         spacing.md,
    gap:             spacing.sm,
  },

  row: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
  },

  dot: {
    width:        8,
    height:       8,
    borderRadius: 4,
    flexShrink:   0,
  },

  modeLabel: {
    flex:     1,
    fontSize: typography.fontSize.md,
    color:    colors.text0,
  },

  smallBtn: {
    backgroundColor:   colors.bg4,
    borderWidth:       1,
    borderColor:       colors.border,
    borderRadius:      radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical:   4,
  },
  smallBtnText: { fontSize: typography.fontSize.sm, color: colors.text2 },

  meta: {
    fontSize:  typography.fontSize.xs,
    color:     colors.text3,
    fontFamily:'Courier New',
    marginTop: 2,
  },

  statRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  statLabel: { fontSize: typography.fontSize.sm, color: colors.text2 },
  statValue: { fontSize: typography.fontSize.sm, color: colors.text0, fontFamily: 'Courier New' },

  syncProgress: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    marginTop:     spacing.xs,
  },
  syncPhase: { fontSize: typography.fontSize.sm, color: colors.accentText },
  syncError: { fontSize: typography.fontSize.sm, color: colors.error },

  syncBtn: {
    backgroundColor: colors.accent,
    borderRadius:    radius.md,
    padding:         spacing.sm,
    alignItems:      'center',
    marginTop:       spacing.xs,
  },
  syncBtnDisabled: { backgroundColor: colors.bg4 },
  syncBtnText: { color: '#fff', fontWeight: '600', fontSize: typography.fontSize.sm },

  hint: {
    fontSize:     typography.fontSize.sm,
    color:        colors.text3,
    marginBottom: spacing.md,
    lineHeight:   18,
  },
  input: {
    backgroundColor:   colors.bg3,
    borderWidth:       1,
    borderColor:       colors.border,
    borderRadius:      radius.md,
    padding:           spacing.md,
    color:             colors.text0,
    fontSize:          typography.fontSize.md,
    marginBottom:      spacing.md,
  },
  btn: {
    backgroundColor: colors.accent,
    borderRadius:    radius.md,
    padding:         spacing.md,
    alignItems:      'center',
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: typography.fontSize.md },
});