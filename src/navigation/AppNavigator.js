// src/navigation/AppNavigator.js
//
// SYNC FIX: useOfflineSearch is now owned here at the root navigator level.
// It is exposed to all screens via SyncContext so there is only ever one
// isSyncingRef, one etag store, and one triggerSync function in the app.
//
// ChatScreen and SettingsScreen both call useSyncContext() to get
// { syncStatus, triggerSync } — no prop drilling, no stale closures,
// no competing hook instances.

import React from 'react';
import { NavigationContainer }      from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text }                     from 'react-native';

import { ChatScreen }     from '../screens/ChatScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { useNetwork }     from '../hooks/useNetwork';
import { useOfflineSearch } from '../hooks/useOfflineSearch';
import { SyncContext }    from '../context/SyncContext';
import { colors }         from '../config/theme';

const Tab = createBottomTabNavigator();

const icon = (label) => ({ focused }) => (
  <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.4 }}>
    {label === 'Chat' ? '◈' : '⚙'}
  </Text>
);

// Inner component so useNetwork (which needs NavigationContainer) can be
// called after the container mounts — lifted here so sync starts immediately.
function AppTabs() {
  const { mode, activeUrl } = useNetwork();
  const { syncStatus, triggerSync } = useOfflineSearch(mode, activeUrl);

  return (
    <SyncContext.Provider value={{ syncStatus, triggerSync }}>
      <Tab.Navigator
        screenOptions={{
          headerShown:             false,
          tabBarStyle: {
            backgroundColor: colors.bg1,
            borderTopColor:  colors.border,
            borderTopWidth:  1,
            height:          58,
            paddingBottom:   8,
          },
          tabBarActiveTintColor:   colors.accent,
          tabBarInactiveTintColor: colors.text3,
          tabBarLabelStyle: { fontFamily: 'Courier New', fontSize: 11 },
        }}
      >
        <Tab.Screen name="Chat"     component={ChatScreen}     options={{ tabBarIcon: icon('Chat')     }} />
        <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: icon('Settings') }} />
      </Tab.Navigator>
    </SyncContext.Provider>
  );
}

export function AppNavigator() {
  return (
    <NavigationContainer>
      <AppTabs />
    </NavigationContainer>
  );
}