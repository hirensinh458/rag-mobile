import React, { useEffect, useRef, useMemo } from 'react';
import { Animated, Text, StyleSheet } from 'react-native';
import { colors } from '../config/theme';

export function NetworkBanner({ serverReachable, serverHasInternet }) {
  const slideAnim = useRef(new Animated.Value(-40)).current;

  // Determine banner state
  const bannerConfig = useMemo(() => {
    if (!serverReachable) {
      return {
        show: true,
        text: '📵 Server unreachable — local retrieval only',
        backgroundColor: 'rgba(239,68,68,0.15)',
        borderColor: 'rgba(239,68,68,0.3)',
        textColor: '#ef8888',
      };
    }

    if (!serverHasInternet) {
      return {
        show: true,
        text: '⚓ At sea mode — manual search only, no AI',
        backgroundColor: 'rgba(251,191,36,0.15)', // orange
        borderColor: 'rgba(251,191,36,0.3)',
        textColor: '#fbbf24',
      };
    }

    return { show: false };
  }, [serverReachable, serverHasInternet]);

  // Animate banner visibility
  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: bannerConfig.show ? 0 : -40,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, [bannerConfig.show]);

  // Don't render anything if fully online
  if (!bannerConfig.show) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          transform: [{ translateY: slideAnim }],
          backgroundColor: bannerConfig.backgroundColor,
          borderBottomColor: bannerConfig.borderColor,
        },
      ]}
    >
      <Text style={[styles.text, { color: bannerConfig.textColor }]}>
        {bannerConfig.text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    borderBottomWidth: 1,
    paddingVertical: 8,
    alignItems: 'center',
  },
  text: {
    fontSize: 12,
    fontFamily: 'Courier New',
    letterSpacing: 0.5,
  },
});