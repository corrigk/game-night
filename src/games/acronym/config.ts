/** Everything tunable about Acronym Attack lives here. */
export const ACRONYM_CONFIG = {
  defaultRounds: 6,
  maxRounds: 30,
  /** Letters in round 1, then in every later round (the host can override in the drawer). */
  firstRoundLetters: 3,
  laterLetters: 4,
  minLetters: 3,
  maxLetters: 5,
  writeSeconds: 45,
  voteSeconds: 20,
  pointsPerVote: 100,
  winnerBonus: 200,
  maxWordLength: 20,
  /** Friendly letters (weights favour common starters). Q, V, X, Z only appear in hard mode. */
  friendlyLetters: 'ABCDEFGHIJKLMNOPRSTUWY',
  hardLetters: 'QVXZ',
  /** Letters not listed here have weight 1. */
  heavyLetters: 'BCDGHLMPRSTW',
};
