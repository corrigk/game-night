import { useEffect } from 'react';
import { DEFAULT_THEME } from '../config';
import type { ThemeId } from '../lib/types';

export const THEMES: { id: ThemeId; name: string; swatch: string[] }[] = [
  { id: 'neon', name: 'Neon Game Show', swatch: ['#0b0618', '#ff2bd6', '#22e4ff'] },
  { id: 'arcade', name: 'Retro Arcade', swatch: ['#070a07', '#39ff14', '#ffcc00'] },
  { id: 'cartoon', name: 'Cartoon Party', swatch: ['#fff3c4', '#ff5a5f', '#3d5afe'] },
  { id: 'glass', name: 'Stained Glass', swatch: ['#140b16', '#d4a73a', '#a3132c', '#1f4fa8'] },
  { id: 'dark', name: 'Clean Dark', swatch: ['#111318', '#6ea8fe', '#ffd166'] },
];

/** Apply a theme to <html data-theme>. Both TV and phones follow the room's theme. */
export function useTheme(theme: ThemeId | undefined) {
  useEffect(() => {
    const id = theme && THEMES.some((t) => t.id === theme) ? theme : DEFAULT_THEME;
    document.documentElement.dataset.theme = id;
    const bg = THEMES.find((t) => t.id === id)?.swatch[0];
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg ?? '#000');
  }, [theme]);
}
