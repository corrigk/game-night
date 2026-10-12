/** Everything tunable about Emoji Translation lives here. */
export const EMOJI_CONFIG = {
  defaultRounds: 8, // clues shown
  maxRounds: 30,
  composeSeconds: 90,
  guessSeconds: 20,
  maxEmoji: 8, // per clue
  decoys: 4, // wrong options per clue (so 5 choices total)
  basePoints: 300, // correct guess
  speedBonusMax: 200, // extra for an instant correct guess, scaled down linearly over the guess timer
  composerPointsPerCorrect: 100, // zero if everyone, or nobody, got it
};

/** The on-screen emoji palette, in case a phone's emoji keyboard is awkward. */
export const EMOJI_PALETTE = [
  '😀', '😂', '😍', '😎', '😱', '😭', '🤔', '😴', '🤢', '😡', '🥶', '🥵',
  '👶', '👦', '👧', '👨', '👩', '👴', '👵', '🧙', '🎅', '👼', '😇', '😈',
  '👀', '👂', '👃', '👄', '💪', '🙏', '👍', '👋', '🤝', '✋', '☝️', '👑',
  '🐶', '🐱', '🐭', '🐰', '🦁', '🐻', '🐟', '🐋', '🦈', '🐍', '🐑', '🐔',
  '🦆', '🐧', '🐝', '🦋', '🐢', '🦖', '🐉', '🦄', '🐘', '🐒', '🕊️', '🐀',
  '🍕', '🌭', '🍔', '🌮', '🍣', '🍝', '🍦', '🍎', '🍞', '🧀', '🥞', '🍿',
  '☕', '🍰', '🍪', '🥫', '🍖', '🥪', '🍯', '🥚', '🐠', '🍞', '🥛', '🍷',
  '🏠', '⛪', '🏰', '🚀', '🚗', '🚢', '✈️', '🚲', '🌍', '🌙', '⭐', '☀️',
  '🌧️', '⛈️', '❄️', '🔥', '💧', '🌈', '🌊', '🌴', '🌹', '🌵', '🏔️', '🏝️',
  '🎵', '🎸', '🎤', '🎬', '📺', '📖', '✝️', '💍', '💰', '🔑', '🗝️', '⚔️',
  '🛡️', '🪄', '💣', '💡', '⏰', '🎁', '🎂', '🕯️', '🔔', '🪜', '🧱', '🪨',
  '❤️', '💔', '💀', '👻', '👽', '🤖', '➕', '➡️', '❓', '❌', '✅', '🔁',
];
