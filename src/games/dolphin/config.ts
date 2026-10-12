/** Everything tunable about Dolphin lives here. */
export const DOLPHIN_CONFIG = {
  defaultRounds: 4,
  /** Default rounds = number of players, but never more than this. */
  defaultRoundsCap: 6,
  maxRounds: 20,
  playSeconds: 90,
  /** The Dolphin scores between min and max, scaled by the fraction of time left. */
  dolphinMaxPoints: 500,
  dolphinMinPoints: 100,
  /** Flat bonus for every other player when the Dolphin solves it. */
  othersBonus: 50,
};
