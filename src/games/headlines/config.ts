/** Everything tunable about Fake Headlines lives here. */
export const HEADLINES_CONFIG = {
  defaultRounds: 6,
  maxRounds: 30,
  writeSeconds: 60,
  voteSeconds: 20,
  maxHeadlineLength: 120,
  /** Second vote for "Most Believable". Set false to play with only the "Funniest" vote. */
  believableVote: true,
  funnyPerVote: 100,
  funnyWinBonus: 200,
  believablePerVote: 100,
  believableWinBonus: 200,
  /** Built-in placeholder photos in /public/headlines, used until you upload a "headline" pool. */
  builtinCount: 8,
};
