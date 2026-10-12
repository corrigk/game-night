const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A grapheme counts as an emoji: pictographs (incl. ZWJ families, skin tones), flags, keycaps. */
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]️?⃣)/u;

/**
 * Keep only emoji from arbitrary text, one entry per user-perceived character (so a family
 * emoji or a flag is ONE emoji, not several). Letters, digits and punctuation are dropped.
 */
export function emojiOnly(input: string, max = Infinity): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(input)) {
    if (EMOJI.test(segment)) out.push(segment);
    if (out.length >= max) break;
  }
  return out;
}
