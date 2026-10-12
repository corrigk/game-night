/** Everything tunable about Movie Voting lives here. */
export const MOVIE_CONFIG = {
  /** Round 1 = submit + first vote; each extra round is a runoff. */
  defaultRounds: 2,
  maxRounds: 5,
  submitSeconds: 90,
  voteSeconds: 60,
  /** Movies each player may suggest. */
  maxSuggestions: 2,
  /** Votes each player gets per round (on different movies). */
  votesPerPlayer: 2,
  maxTitleLength: 60,
  /** How many movies move forward after round 1, and after each later round. Ties at the cutoff all advance. */
  advanceAfterFirst: 3,
  advanceAfterLater: 2,
};
