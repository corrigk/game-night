import type { ThemeId } from './lib/types';

/** Default names shown on the phone join screen. Editable live from the host drawer. */
export const DEFAULT_ROSTER = [
  'Joshua', 'Gabriel', 'Nicolas', 'Andrew', 'Kevin', 'Cristian',
  'Adrianna', 'Abigail', 'Sarah', 'Amelia', 'Stephanie', 'Kathleen',
];

export const DEFAULT_THEME: ThemeId = 'neon';
export const MAX_PLAYERS = 20;

export const EMOJIS = [
  '🦊', '🐸', '🐙', '🦄', '🐼', '🐯', '🦖', '🐧', '🦉', '🐝', '🦩', '🐳',
  '👽', '🤖', '👻', '🎃', '🤠', '🥸', '😎', '🤡', '🧙', '🧛', '🦸', '🥷',
  '🍕', '🌮', '🍩', '🥑', '🌶️', '🍄', '🌵', '🌈', '🔥', '⚡', '💎', '🎸',
  '🚀', '🛸', '🎲', '👑',
];

/**
 * Player colors: 20 distinct swatches. They are always drawn as filled chips with
 * auto-contrast text and an outline, so they stay readable on every theme.
 */
export const PLAYER_COLORS: { hex: string; name: string }[] = [
  { hex: '#e53935', name: 'Red' },
  { hex: '#fb8c00', name: 'Orange' },
  { hex: '#ffc107', name: 'Gold' },
  { hex: '#fff176', name: 'Lemon' },
  { hex: '#c0ca33', name: 'Lime' },
  { hex: '#43a047', name: 'Green' },
  { hex: '#a5d6a7', name: 'Mint' },
  { hex: '#00897b', name: 'Teal' },
  { hex: '#26c6da', name: 'Cyan' },
  { hex: '#81d4fa', name: 'Sky' },
  { hex: '#1e88e5', name: 'Blue' },
  { hex: '#3949ab', name: 'Indigo' },
  { hex: '#b39ddb', name: 'Lavender' },
  { hex: '#8e24aa', name: 'Purple' },
  { hex: '#d81b60', name: 'Magenta' },
  { hex: '#f48fb1', name: 'Pink' },
  { hex: '#ffab91', name: 'Peach' },
  { hex: '#8d6e63', name: 'Brown' },
  { hex: '#607d8b', name: 'Slate' },
  { hex: '#f5f5f5', name: 'White' },
];

export function colorName(hex: string): string {
  return PLAYER_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
}

/** Black or white text, whichever reads better on the given fill. */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.22 ? '#111111' : '#ffffff';
}
