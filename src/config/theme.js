import { Dimensions } from 'react-native';

const { width, height } = Dimensions.get('window');
export const SCREEN_WIDTH  = width;
export const SCREEN_HEIGHT = height;
export const isSmallScreen = width < 380;

// Minimum tap target size per accessibility guidelines
export const minTapTarget = 44;

export const colors = {
  // Backgrounds
  bg0:        '#07070C',   // main screen background
  bg1:        '#0E0E16',   // header, tab bar, input wrapper
  bg2:        '#141420',   // assistant message bubble
  bg3:        '#1C1C2A',   // offline chunk cards
  bg4:        '#252535',   // text input background
  bg5:        '#2E2E42',   // pressed / active state

  // Text
  text0:      '#F4F3FF',   // primary  (high contrast)
  text1:      '#C8C7DC',   // body text
  text2:      '#8E8DA4',   // secondary label
  text3:      '#5C5B72',   // disabled / placeholder

  // Brand
  accent:     '#7C6AF7',
  accentDim:  '#5A4BC0',
  accentText: '#A999FA',

  // Mode status — used in banner + badge
  online:     '#22C55E',   // Mode 1: full online
  intranet:   '#F59E0B',   // Mode 2: server up, no internet
  offline:    '#EF4444',   // Mode 3: deep offline

  // Semantic
  teal:       '#2DD4BF',
  tealDim:    'rgba(45,212,191,0.08)',
  error:      '#EF4444',
  success:    '#22C55E',

  // Borders
  border:     'rgba(255,255,255,0.07)',
  borderMd:   'rgba(255,255,255,0.13)',
  borderHi:   'rgba(255,255,255,0.22)',
};

export const spacing = {
  xs: 4, sm: 8, md: 14, lg: 20, xl: 28, xxl: 40,
};

export const radius = {
  sm: 6, md: 12, lg: 18, xl: 24, full: 999,
};

export const typography = {
  fontMono: 'Courier New',
  fontSize: {
    xs:  11,
    sm:  13,
    md:  15,
    lg:  17,
    xl:  20,
    xxl: 24,
  },
};