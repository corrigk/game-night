/** score_events.reason strings and point values. The Awards screen reads these back. */
export const REASON = {
  tapPrefix: 'Tap Race:',
  tapWin: 'Tap Race: #1',
  mltMatch: 'Most Likely To: matched the majority',
  wfTruth: 'Weird Facts: found the truth',
  wfFooled: 'Weird Facts: fooled players',
  capVotes: 'Caption This: votes received',
  capWin: 'Caption This: round winner',
  zilVotes: 'Zillow Hunt: gallery votes',
  zilFinal: 'Zillow Hunt: final placement',
  talent: 'Talent Show: performance',
  talentEncore: 'Talent Show: encores',
  emojiGuess: 'Emoji Translation: correct guess',
  emojiComposer: 'Emoji Translation: clue artist',
} as const;

export const WF_TRUTH_POINTS = 300;
export const WF_FOOLED_POINTS = 150;
export const CAP_VOTE_POINTS = 100;
export const CAP_WIN_BONUS = 200;
