/** Everything tunable about Mad Libs Theatre lives here. */
export const MADLIBS_CONFIG = {
  /** Rounds = scripts played in a night (the host can queue more). */
  defaultRounds: 1,
  maxRounds: 6,
  /**
   * Fill timer = base + secondsPerWord × words each (about 15s per word plus 20s). The host can add
   * time with +15s.
   */
  fillBaseSeconds: 20,
  fillSecondsPerWord: 15,
  /** Cap on words per player so the fill phase stays short (host-adjustable in the drawer). */
  maxWordsPerPlayer: 4,
  volunteerSeconds: 20,
  /** The "Curtain up!" 3-2-1. */
  curtainSeconds: 3,
  /** Besides the host's Space, the performer who just finished can tap Done to advance. */
  doneOverride: true,
  /** Finale reading pace: seconds per line = chars / charsPerSecond, clamped. */
  finaleCharsPerSecond: 14,
  finaleMinSeconds: 4,
  finaleMaxSeconds: 12,
  maxWordLength: 40,
  /** Last-resort fallback for a blank that has no `default` of its own. */
  placeholders: [
    'a suspiciously large goose',
    'banana',
    'Gary',
    'a very small trombone',
    'mashed potatoes',
    'the bishop\'s nephew',
    'spaghetti',
    'a tiny hat',
    'Tuesday',
    'a sleepy llama',
    'soup',
    'a concerned pigeon',
  ],
};
