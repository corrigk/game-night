/** Everything tunable about Hot Seat lives here. */
export const HOT_SEAT_CONFIG = {
  defaultRounds: 2, // a round = every team goes once
  maxRounds: 6,
  turnSeconds: 60,
  summarySeconds: 8,
  skipsPerTurn: 3,
  /** Team points lost per skip. */
  skipPenalty: 1,
  /** Team points gained per correct word. */
  pointPerWord: 1,
  /** A buzzer can't buzz again for this long. */
  buzzCooldownSeconds: 4,
  /** Each member of the winning team (ties: both teams) gets this on the individual leaderboard. */
  winnerBonus: 300,
};
