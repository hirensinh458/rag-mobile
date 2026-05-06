// src/screens/SettingsScreen.js  — P5 (reconciled) + SyncContext wiring
//
// SYNC FIX: no longer receives triggerSync / syncStatus as props or route params.
// Both are read directly from SyncContext (which AppNavigator provides).
// This means the sync buttons work regardless of how the screen is reached
// (tab tap vs ⚙ button) and triggerSync is never a stale closure.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import AsyncStorage          from '@react-native-async-storage/async-storage';
import { fetchHealth, fetchStats } from '../api/kb';
import { invalidateUrlCache }      from '../api/client';
import { getChunkCount, getVectorCount, getAllSyncMeta } from '../offline/db';
import { useSyncContext }           from '../context/SyncContext';
import { Config }                  from '../config';
import { colors, spacing, radius, typography, minTapTarget } from '../config/theme';

const normalizeUrl = (value) => (value || '').trim();

export function SettingsScreen() {
  // Live sync state + trigger from the single shared hook instance
  const { syncStatus, triggerSync } = useSyncContext();

  const [cloudUrl,     setCloudUrl]     = useState('');
  const [localUrl,     setLocalUrl]     = useState('');
  const [health,       setHealth]       = useState(null);
  const [stats,        setStats]        = useState(null);
  const [chunkCount,   setChunkCount]   = useState(null);
  const [vectorCount,  setVectorCount]  = useState(null);
  const [checking,     setChecking]     = useState(false);
  const [saveFeedback, setSaveFeedback] = useState('');
  const [lastSynced,   setLastSynced]   = useState(null);

  const isSyncing  = syncStatus?.isSyncing   ?? false;
  const syncResult = syncStatus?.lastResult  ?? null;

  const [activeUrl,    setActiveUrl]    = useState(
    normalizeUrl(Config.API_BASE_URL || Config.LOCAL_URL)
  );
  const [activeSource, setActiveSource] = useState('local');

  // ── Mount: load saved URLs + DB counts + last-synced ──
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem('cloud_url'),
      AsyncStorage.getItem('local_url'),
    ]).then(([c, l]) => {
      setCloudUrl(c || Config.CLOUD_URL || '');
      setLocalUrl(l || Config.LOCAL_URL || '');
      setActiveUrl(normalizeUrl(Config.API_BASE_URL || l || Config.LOCAL_URL || Config.CLOUD_URL));
      setActiveSource('local');
    });

    Promise.all([getChunkCount(), getVectorCount()])
      .then(([count, vcount]) => {
        setChunkCount(count);
        setVectorCount(vcount);
      })
      .catch(() => { setChunkCount(0); setVectorCount(0); });

    getAllSyncMeta()
      .then(meta => { if (meta.last_synced) setLastSynced(meta.last_synced); })
      .catch(() => {});
  }, []);

  // ── Mirror syncStatus into local display state ──
  useEffect(() => {
    if (syncStatus?.chunkCount  !== undefined) setChunkCount(syncStatus.chunkCount);
    if (syncStatus?.vectorCount !== undefined) setVectorCount(syncStatus.vectorCount);
    if (syncStatus?.lastSynced)               setLastSynced(syncStatus.lastSynced);
  }, [syncStatus?.chunkCount, syncStatus?.vectorCount, syncStatus?.lastSynced]);

  // ── URL helpers ──
  const saveUrls = async () => {
    await Promise.all([
      AsyncStorage.setItem('cloud_url',  cloudUrl.trim()),
      AsyncStorage.setItem('local_url',  localUrl.trim()),
      AsyncStorage.setItem('server_url', localUrl.trim() || cloudUrl.trim()),
    ]);
    invalidateUrlCache();
    setSaveFeedback('Saved ✓');
    setTimeout(() => setSaveFeedback(''), 2000);
  };

  const probeUrl = useCallback(async (url) => {
    const target = normalizeUrl(url);
    if (!target) return false;
    try {
      const h = await fetchHealth(null, target);
      return Boolean(h && !h.error && h.is_online !== false);
    } catch {
      return false;
    }
  }, []);

  const resolvePreferredUrl = useCallback(async () => {
    const cloud    = normalizeUrl(cloudUrl || Config.CLOUD_URL);
    const local    = normalizeUrl(localUrl || Config.LOCAL_URL);
    const fallback = normalizeUrl(Config.API_BASE_URL || Config.LOCAL_URL || local || cloud);
    if (await probeUrl(cloud)) return { url: cloud,    source: 'cloud'    };
    if (await probeUrl(local)) return { url: local,    source: 'local'    };
    return                            { url: fallback, source: 'fallback' };
  }, [cloudUrl, localUrl, probeUrl]);

  const resolveAndCacheUrl = useCallback(async () => {
    const resolved = await resolvePreferredUrl();
    if (resolved.url && resolved.url !== activeUrl) {
      setActiveUrl(resolved.url);
      setActiveSource(resolved.source);
      await AsyncStorage.setItem('server_url', resolved.url);
      invalidateUrlCache();
    }
    return resolved;
  }, [resolvePreferredUrl, activeUrl]);

  const getActiveUrl = useCallback(() => {
    return activeUrl || normalizeUrl(
      Config.API_BASE_URL || Config.LOCAL_URL || localUrl || cloudUrl
    );
  }, [activeUrl, localUrl, cloudUrl]);

  // ── Server health check ──
  const checkHealth = async () => {
    setChecking(true);
    setHealth(null);
    setStats(null);
    try {
      const resolved = await resolveAndCacheUrl();
      const url      = resolved.url;
      const [h, s]   = await Promise.all([
        fetchHealth(null, url),
        fetchStats(url).catch(() => null),
      ]);
      setHealth(h);
      setStats(s);
      setActiveUrl(url);
      setActiveSource(resolved.source);
    } catch (e) {
      setHealth({ error: e.message });
    } finally {
      setChecking(false);
    }
  };

  // ── Standard sync — respects etag check ──
  const handleSync = useCallback(async () => {
    if (isSyncing) return;
    const resolved = await resolveAndCacheUrl();
    const url      = resolved.url || getActiveUrl();
    if (!url) return;
    triggerSync(url, { force: false });
  }, [isSyncing, resolveAndCacheUrl, getActiveUrl, triggerSync]);

  // ── Force sync — bypasses etag check ──
  const handleForceSync = useCallback(async () => {
    if (isSyncing) return;
    const resolved = await resolveAndCacheUrl();
    const url      = resolved.url || getActiveUrl();
    if (!url) return;
    triggerSync(url, { force: true });
  }, [isSyncing, resolveAndCacheUrl, getActiveUrl, triggerSync]);

  // ── Refresh DB counts manually ──
  const handleRefreshCounts = useCallback(async () => {
    const [count, vcount] = await Promise.all([getChunkCount(), getVectorCount()]);
    setChunkCount(count);
    setVectorCount(vcount);
  }, []);

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

      {/* ── Server URLs ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Server URLs</Text>
        <Text style={styles.cardHint}>
          Cloud URL (primary — Mode 1 with internet, Mode 2 without):{'\n'}
          Leave blank if only using a local server.
        </Text>
        <TextInput
          style={styles.input}
          value={cloudUrl}
          onChangeText={setCloudUrl}
          placeholder="http://192.168.1.10:8001  (optional)"
          placeholderTextColor={colors.text3}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={[styles.cardHint, { marginTop: spacing.xs }]}>
          Local URL (fallback — used when cloud is unreachable):{'\n'}
          Android emulator: http://10.0.2.2:8000
        </Text>
        <TextInput
          style={styles.input}
          value={localUrl}
          onChangeText={setLocalUrl}
          placeholder="http://192.168.1.10:8000"
          placeholderTextColor={colors.text3}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <TouchableOpacity style={styles.btn} onPress={saveUrls} activeOpacity={0.8}>
          <Text style={styles.btnText}>{saveFeedback || 'Save URLs'}</Text>
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
        {/* Title row with refresh button */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={styles.cardTitle}>Local Database</Text>
          <TouchableOpacity
            onPress={handleRefreshCounts}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.6}
          >
            <Text style={{ fontSize: 18, color: colors.teal }}>↻</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statGrid}>
          <StatRow
            label="Cached chunks"
            value={chunkCount === null ? '…' : chunkCount.toLocaleString()}
          />
          <StatRow
            label="Vectors (sqlite-vec)"
            value={vectorCount === null ? '…' : vectorCount.toLocaleString()}
          />
          {lastSynced && (
            <StatRow
              label="Last synced"
              value={new Date(lastSynced).toLocaleString()}
            />
          )}
          {syncStatus?.lastEtag && (
            <StatRow
              label="KB version (etag)"
              value={syncStatus.lastEtag.slice(0, 12) + '…'}
            />
          )}
        </View>

        {/* Standard sync */}
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary]}
          onPress={handleSync}
          disabled={isSyncing}
          activeOpacity={0.8}
        >
          {isSyncing
            ? <ActivityIndicator size="small" color={colors.accent} />
            : <Text style={styles.btnTextSecondary}>⬇  Sync from Server</Text>
          }
        </TouchableOpacity>

        {/* Force sync */}
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary, { opacity: isSyncing ? 0.5 : 1 }]}
          onPress={handleForceSync}
          disabled={isSyncing}
          activeOpacity={0.8}
        >
          <Text style={styles.btnTextSecondary}>⚡ Force Full Sync</Text>
        </TouchableOpacity>

        {syncResult && !syncResult.error && (
          <View style={styles.healthRow}>
            <View style={[styles.healthDot, { backgroundColor: colors.success }]} />
            <Text style={[styles.healthLabel, { color: colors.success }]}>
              {syncResult.chunksSkipped
                ? 'Up to date (304 — no changes)'
                : `Synced ${syncResult.chunks?.toLocaleString()} chunks · ${syncResult.vectors} vectors`
              }
              {syncResult.pdfsSynced  > 0 ? ` · ${syncResult.pdfsSynced} PDFs`    : ''}
              {syncResult.pdfsDeleted > 0 ? ` · ${syncResult.pdfsDeleted} removed` : ''}
            </Text>
          </View>
        )}
        {syncResult?.error && (
          <View style={styles.healthRow}>
            <View style={[styles.healthDot, { backgroundColor: colors.error }]} />
            <Text style={[styles.healthLabel, { color: colors.error }]}>
              Sync failed: {syncResult.error}
            </Text>
          </View>
        )}

        <Text style={styles.cardHint}>
          Auto-syncs when server becomes reachable (every 10 min).{'\n'}
          Vectors enable semantic search in deep-offline mode.
        </Text>
      </View>

      {/* ── About ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>About</Text>
        <Text style={styles.aboutText}>
          MarineDoc v1.0  ·  Hybrid RAG Ship Manual Assistant{'\n\n'}
          Mode 1 — Online: AI-powered answers (Groq){'\n'}
          Mode 2 — At Sea: Server-side manual retrieval{'\n'}
          Mode 3 — Offline: Hybrid BM25 + semantic search
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
  row: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    paddingVertical:   spacing.xs,
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
    fontSize:      typography.fontSize.xxl,
    color:         colors.text0,
    fontWeight:    '700',
    marginBottom:  spacing.xl,
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

  healthRow:   { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.xs },
  healthDot:   { width: 8, height: 8, borderRadius: 4 },
  healthLabel: { fontSize: typography.fontSize.sm, flex: 1, lineHeight: 20 },

  statGrid: { gap: 2 },

  aboutText: {
    fontSize:   typography.fontSize.sm,
    color:      colors.text2,
    lineHeight: 22,
    fontFamily: typography.fontMono,
  },
});