import { comingSoon } from './comingSoon';
import { tapRace } from './taprace/tapRace';
import type { GameModule } from './types';

/**
 * Every game on the hub, in display order. To add a game: write a GameModule
 * (see games/types.ts) and list it here. No database changes needed.
 */
export const GAME_LIST: GameModule[] = [
  comingSoon({ id: 'most_likely', title: 'Most Likely To', emoji: '👉', tagline: 'Point fingers. Anonymously-ish.', scored: true, defaultRounds: 8, step: 2 }),
  comingSoon({ id: 'weird_facts', title: 'Weird Facts', emoji: '🧐', tagline: 'Fake the fact. Find the truth.', scored: true, defaultRounds: 6, step: 3 }),
  comingSoon({ id: 'caption_this', title: 'Caption This', emoji: '🖼️', tagline: 'One photo. Many bad ideas.', scored: true, defaultRounds: 6, step: 4 }),
  comingSoon({ id: 'story_chain', title: 'Story Chain', emoji: '📜', tagline: 'Write blind. Read aloud. No points, just chaos.', scored: false, defaultRounds: 6, step: 5 }),
  comingSoon({ id: 'zillow_hunt', title: 'Zillow Hunt', emoji: '🏠', tagline: 'Find the dream home. Sell it to the room.', scored: true, defaultRounds: 3, step: 6 }),
  tapRace,
];

export const GAMES: Record<string, GameModule> = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));
