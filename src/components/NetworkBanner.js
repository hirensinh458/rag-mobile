// src/components/NetworkBanner.js
import React, { useEffect, useRef, useMemo } from 'react';
import { Animated, Text, StyleSheet } from 'react-native';

const BANNER_HEIGHT = 36;

/**
 * Props:
 *   serverReachable   boolean — can the app reach the FastAPI server?
 *   serverHasInternet boolean — does the server have internet (for Groq)?
 *
 * Shows nothing when fully online.
 * Amber when server up but no Groq (at-sea / intranet mode).
 * Red when server unreachable (deep offline).
 */
export function NetworkBanner({ serverReachable, serverHasInternet }) {
  const slideAnim = useRef(new Animated.Value(-BANNER_HEIGHT)).current;

  const config = useMemo(() => {
    if (!serverReachable) {
      return {
        show:   true,
        text:   '📵  Server unreachable — local search only',
        bg:     'rgba(239,68,68,0.15)',
        border: 'rgba(239,68,68,0.30)',
        color:  '#F87171',
      };
    }
    if (!serverHasInternet) {
      return {
        show:   true,
        text:   '⚓  At sea — manual section search only, no AI',
        bg:     'rgba(245,158,11,0.15)',
        border: 'rgba(245,158,11,0.30)',
        color:  '#FBBF24',
      };
    }
    return { show: false };
  }, [serverReachable, serverHasInternet]);

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue:         config.show ? 0 : -BANNER_HEIGHT,
      useNativeDriver: true,
      tension:         80,
      friction:        10,
    }).start();
  }, [config.show, slideAnim]);

  if (!config.show) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          transform:         [{ translateY: slideAnim }],
          backgroundColor:   config.bg,
          borderBottomColor: config.border,
        },
      ]}
    >
      <Text style={[styles.text, { color: config.color }]}>{config.text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    height:            BANNER_HEIGHT,
    borderBottomWidth: 1,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 16,
  },
  text: {
    fontSize:     12,
    fontFamily:   'Courier New',
    letterSpacing: 0.4,
  },
});