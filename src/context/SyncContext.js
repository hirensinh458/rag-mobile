// src/context/SyncContext.js
//
// Holds the single useOfflineSearch instance at the navigation root level.
// Both ChatScreen and SettingsScreen consume from this context, which means:
//   - Only one isSyncingRef ever exists (no race conditions)
//   - triggerSync is never stale (context always holds the live reference)
//   - SettingsScreen works whether reached via tab tap or ⚙ button

import React, { createContext, useContext } from 'react';

export const SyncContext = createContext({
  syncStatus:   { isSyncing: false, lastSynced: null, chunkCount: 0, vectorCount: 0, lastResult: null },
  triggerSync:  () => {},
});

export function useSyncContext() {
  return useContext(SyncContext);
}