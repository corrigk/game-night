import { acronymAttack } from './acronym/acronymAttack';
import { captionThis } from './caption/captionThis';
import { fakeHeadlines } from './headlines/fakeHeadlines';
import { madlibsTheatre } from './madlibs/madlibsTheatre';
import { plotTwist } from './plottwist/plotTwist';
import { dolphin } from './dolphin/dolphin';
import { hotSeat } from './hotseat/hotSeat';
import { emojiTranslation } from './emoji/emojiTranslation';
import { mostLikely } from './mostLikely/mostLikely';
import { movieVoting } from './movies/movieVoting';
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
  emojiTranslation,
  dolphin,
  hotSeat,
  movieVoting,
  acronymAttack,
  plotTwist,
  fakeHeadlines,
  madlibsTheatre,
  tapRace,
];

export const GAMES: Record<string, GameModule> = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));
