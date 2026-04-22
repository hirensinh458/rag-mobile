// src/components/NetworkBanner.js
//
// REWRITE: Mode-aware animated banner.
//   - ONLINE      → no banner (collapses to 0 height with animation)
//   - LAN_ONLY    → purple info strip
//   - DEEP_OFFLINE → red warning strip

import React, { useEffect, useRef }  from 'react';
import { Animated, Text, StyleSheet } from 'react-native';
import { NetworkMode }                from '../hooks/useNetwork';
import { colors, typography }         from '../config/theme';

const BANNER_HEIGHT = 34;

const CONFIG = {
  [NetworkMode.ONLINE]: null, // no banner

  [NetworkMode.LAN_ONLY]: {
    bg:  'rgba(124, 106, 247, 0.15)',
    msg: '◑  LAN mode — server connected, no internet · retrieval only',
    fg:  colors.accentText,
  },

  [NetworkMode.DEEP_OFFLINE]: {
    bg:  'rgba(239, 68, 68, 0.12)',
    msg: '○  Server unreachable — using local database',
    fg:  colors.error,
  },
};

export function NetworkBanner({ mode }) {
  const heightAnim = useRef(new Animated.Value(0)).current;
  const config     = CONFIG[mode];

  useEffect(() => {
    Animated.timing(heightAnim, {
      toValue:         config ? BANNER_HEIGHT : 0,
      duration:        250,
      useNativeDriver: false, // animating height — must be false
    }).start();
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Always render the Animated.View so collapse animation plays correctly.
  // When config is null (ONLINE), the view just collapses to 0 height.
  return (
    <Animated.View
      style={[
        styles.banner,
        { height: heightAnim, backgroundColor: config?.bg ?? 'transparent' },
      ]}
    >
      {config ? (
        <Text style={[styles.text, { color: config.fg }]} numberOfLines={1}>
          {config.msg}
        </Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    justifyContent: 'center',
    alignItems:     'center',
    overflow:       'hidden',
    paddingHorizontal: 12,
  },
  text: {
    fontSize:   typography.fontSize.xs,
    fontFamily: 'Courier New',
    letterSpacing: 0.2,
  },
});