import { captionThis } from './caption/captionThis';
import { mostLikely } from './mostLikely/mostLikely';
import { storyChain } from './story/storyChain';
import { talentShow } from './talent/talentShow';
import { tapRace } from './taprace/tapRace';
import { weirdFacts } from './weirdFacts/weirdFacts';
import { zillowHunt } from './zillow/zillowHunt';
import type { GameModule } from './types';

/**
 * Every game on the hub, in display order. To add a game: write a GameModule
 * (see games/types.ts) and list it here. No database changes needed.
 */
export const GAME_LIST: GameModule[] = [
  mostLikely,
  weirdFacts,
  captionThis,
  storyChain,
  zillowHunt,
  talentShow,
  tapRace,
];

export const GAMES: Record<string, GameModule> = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));
