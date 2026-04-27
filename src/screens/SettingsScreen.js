// src/screens/SettingsScreen.js  — P5: Added vector count stat + Force Sync button
//
// CHANGES FROM PREVIOUS VERSION:
//   - vectorCount state added; populated from getVectorCount() after each sync
//   - "Vectors (sqlite-vec)" stat row shown in Local Database card
//   - "⚡ Force Full Sync" button added (bypasses stale check, for debugging)
//   - triggerSync() called with { force: true } from the Force Sync button
//   - Sync result text updated to show vector count
//   - About text updated to reflect hybrid Mode 3

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { invalidateUrlCache } from '../api/client';
import { fetchHealth, fetchStats } from '../api/kb';
import { useOfflineSearch }       from '../hooks/useOfflineSearch';
import { getChunkCount, getVectorCount } from '../offline/db';
import { colors, spacing, radius, typography, minTapTarget } from '../config/theme';

export function SettingsScreen() {
  const [cloudUrl,     setCloudUrl]     = useState('');
  const [localUrl,     setLocalUrl]     = useState('');
  const [saveFeedback, setSaveFeedback] = useState('');
  const [checking,     setChecking]     = useState(false);
  const [health,       setHealth]       = useState(null);
  const [stats,        setStats]        = useState(null);
  const [syncing,      setSyncing]      = useState(false);
  const [syncResult,   setSyncResult]   = useState(null);
  const [chunkCount,   setChunkCount]   = useState(null);
  const [vectorCount,  setVectorCount]  = useState(null);  // P5
  const [lastSynced,   setLastSynced]   = useState(null);

  // Shared sync hook — we only use triggerSync here (not the auto-sync side)
  const { triggerSync } = useOfflineSearch('full_online', ''); // mode unused in settings

  // Get the active URL for manual sync (prefer cloud_url, fall back to local_url)
  const getActiveUrl = useCallback(async () => {
    const cloud  = (await AsyncStorage.getItem('cloud_url') || '').trim();
    const local  = (await AsyncStorage.getItem('local_url') || '').trim();
    return cloud || local || '';
  }, []);

  // Track separate runtime URL for manual sync button
  const [syncRuntimeUrl, setSyncRuntimeUrl] = useState('');

  // Load saved URLs + DB stats on mount
  useEffect(() => {
    (async () => {
      const [cloud, local, count, vcount, ls] = await Promise.all([
        AsyncStorage.getItem('cloud_url').catch(() => ''),
        AsyncStorage.getItem('local_url').catch(() => ''),
        getChunkCount(),
        getVectorCount(),
        AsyncStorage.getItem('last_synced_display').catch(() => null),
      ]);
      setCloudUrl(cloud  || '');
      setLocalUrl(local  || '');
      setChunkCount(count);
      setVectorCount(vcount);
      setLastSynced(ls);

      const url = (cloud || local || '').trim();
      setSyncRuntimeUrl(url);
    })();
  }, []);

  // Refresh DB stats after each sync
  useEffect(() => {
    (async () => {
      const [count, vcount] = await Promise.all([getChunkCount(), getVectorCount()]);
      setChunkCount(count);
      setVectorCount(vcount);
    })();
  }, [syncResult]);

  const saveUrls = async () => {
    await AsyncStorage.setItem('cloud_url', cloudUrl.trim());
    await AsyncStorage.setItem('local_url', localUrl.trim());
    invalidateUrlCache();
    const url = (cloudUrl.trim() || localUrl.trim());
    setSyncRuntimeUrl(url);
    setSaveFeedback('Saved ✓');
    setTimeout(() => setSaveFeedback(''), 2000);
  };

  const checkHealth = async () => {
    setChecking(true);
    setHealth(null);
    setStats(null);
    try {
      const url    = await getActiveUrl();
      const [h, s] = await Promise.all([
        fetchHealth(null, url),
        fetchStats(url).catch(() => null),
      ]);
      setHealth(h);
      setStats(s);
    } catch (e) {
      setHealth({ error: e.message });
    } finally {
      setChecking(false);
    }
  };

  // ── Manual sync (normal — respects stale check) ──
  const handleSync = useCallback(async () => {
    if (syncing) return;
    const url = syncRuntimeUrl || (await getActiveUrl());
    if (!url) {
      setSyncResult({ error: 'No server URL configured' });
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    try {
      // We call triggerSync with force=false — same as auto-sync
      // But we need the result, so we duplicate the inner logic here
      const { replaceAllChunksWithVectors, setSyncMeta: setMeta, getChunkCount: cc, getVectorCount: vc } =
        require('../offline/db');
      const { syncPdfs }  = require('../offline/pdfSync');
      const { apiFetch: af } = require('../api/client');
      const { getSyncMeta: gm } = require('../offline/db');

      const storedEtag = await gm('export_etag') || '';
      const res = await af('/kb/export?include_vectors=true', url, {
        headers: storedEtag ? { 'If-None-Match': storedEtag } : {},
      });

      let result;
      if (res.status === 304) {
        const pdfRes = await syncPdfs(url);
        result = { chunks: 0, vectors: 0, chunksSkipped: true, pdfsSynced: pdfRes.synced.length, pdfsDeleted: pdfRes.deleted.length, errors: pdfRes.errors };
      } else if (res.ok) {
        const data    = await res.json();
        const chunks  = data.chunks || [];
        const newEtag = data.etag || res.headers.get('X-Export-Etag') || '';
        await replaceAllChunksWithVectors(chunks);
        if (newEtag) await setMeta('export_etag', newEtag);
        const pdfRes  = await syncPdfs(url);
        const count   = await cc();
        const vcount  = await vc();
        await setMeta('last_synced', new Date().toISOString());
        await setMeta('chunk_count', String(count));
        await setMeta('vector_count', String(vcount));
        result = { chunks: chunks.length, vectors: chunks.filter(c=>c.embedding).length, chunksSkipped: false, pdfsSynced: pdfRes.synced.length, pdfsDeleted: pdfRes.deleted.length, errors: pdfRes.errors };
      } else {
        throw new Error(`/kb/export failed: ${res.status}`);
      }

      setSyncResult(result);
      setLastSynced(new Date().toISOString());
    } catch (e) {
      setSyncResult({ error: e.message });
    } finally {
      setSyncing(false);
    }
  }, [syncing, syncRuntimeUrl, getActiveUrl]);

  // ── P5: Force sync (bypasses stale check) ──
  const handleForceSync = useCallback(async () => {
    if (syncing) return;
    const url = syncRuntimeUrl || (await getActiveUrl());
    if (!url) { setSyncResult({ error: 'No server URL configured' }); return; }
    // triggerSync with force=true skips the stale check
    setSyncing(true);
    try {
      await triggerSync(url, { force: true });
      const [count, vcount] = await Promise.all([getChunkCount(), getVectorCount()]);
      setSyncResult({ chunks: count, vectors: vcount, chunksSkipped: false, pdfsSynced: 0, pdfsDeleted: 0, errors: [] });
    } catch(e) {
      setSyncResult({ error: e.message });
    } finally {
      setSyncing(false);
    }
  }, [syncing, syncRuntimeUrl, getActiveUrl, triggerSync]);

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
        <Text style={styles.cardTitle}>Local Database</Text>
        <View style={styles.statGrid}>
          <StatRow
            label="Cached chunks"
            value={chunkCount === null ? '…' : chunkCount.toLocaleString()}
          />
          {/* P5: Vector count stat */}
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
        </View>

        {/* Standard sync — respects stale check */}
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary]}
          onPress={handleSync}
          disabled={syncing}
          activeOpacity={0.8}
        >
          {syncing
            ? <ActivityIndicator size="small" color={colors.accent} />
            : <Text style={styles.btnTextSecondary}>⬇  Sync from Server</Text>
          }
        </TouchableOpacity>

        {/* P5: Force sync button — bypasses stale check */}
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary, { opacity: syncing ? 0.5 : 1 }]}
          onPress={handleForceSync}
          disabled={syncing}
          activeOpacity={0.8}
        >
          <Text style={styles.btnTextSecondary}>⚡ Force Full Sync</Text>
        </TouchableOpacity>

        {/* Sync result feedback */}
        {syncResult && !syncResult.error && (
          <View style={styles.healthRow}>
            <View style={[styles.healthDot, { backgroundColor: colors.success }]} />
            <Text style={[styles.healthLabel, { color: colors.success }]}>
              {syncResult.chunksSkipped
                ? 'Up to date (304 — no changes)'
                : `Synced ${syncResult.chunks.toLocaleString()} chunks · ${syncResult.vectors} vectors`
              }
              {syncResult.pdfsSynced  > 0 ? ` · ${syncResult.pdfsSynced} PDFs` : ''}
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
  row:   {
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