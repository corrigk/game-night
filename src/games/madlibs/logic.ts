import { shuffle } from '../../lib/random';

/** Pure Mad Libs rules (no React, no database): dealing blanks and rendering filled words. */

export interface Role {
  name: string;
  color: string;
}
export interface Blank {
  id: string;
  prompt?: string;
  kind: 'free' | 'roster';
  /** Word type, e.g. "adj", "animal", "saint". */
  type?: string;
  /** A funny fallback used whenever nobody supplies the word. */
  default?: string;
}
export interface Line {
  role: string;
  text: string;
  direction?: string;
}
export interface Template {
  dbId?: string;
  slug: string;
  title: string;
  description?: string;
  roles: Role[];
  blanks: Blank[];
  lines: Line[];
}
export interface Fill {
  word: string;
  /** The player who wrote it; null for names and defaults. */
  by: string | null;
  /** True when the blank's `default` was used (nobody wrote it). */
  auto?: boolean;
  /** True when it was filled from the player list. */
  roster?: boolean;
}
export type Seg = { t: string } | { w: string; by: string | null; auto: boolean };

const PH = /\{\{\s*([^}\s]+)\s*\}\}/g;

// ---------------------------------------------------------------- a / an
/** "a" or "an" for a word, going by its first sound (a simple rule, not a dictionary). */
export function articleFor(word: string): 'a' | 'an' {
  const w = word.trim().toLowerCase();
  if (!w) return 'a';
  if (/^(hour|honest|honor|honour|heir)/.test(w)) return 'an';
  // Starts with a vowel letter but sounds like "yoo"/"wun": a unicorn, a user, a one-man band, a European.
  if (/^(uni(?![nmd])|use|usu|ute|uti|eu|ewe|one|once|ubiq|uran)/.test(w)) return 'a';
  if (/^[aeiou]/.test(w)) return 'an';
  if (/^(8|11|18)/.test(w)) return 'an'; // an 8, an 11, an 18, an 80...
  return 'a';
}

const withCase = (original: string, article: string) => (original[0] === original[0].toUpperCase() ? article[0].toUpperCase() + article.slice(1) : article);
const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------- rendering
/**
 * Fill a line's {{blanks}} and tidy the grammar:
 *  - "a"/"an" right before a filled word is corrected to match it ("a umbrella" -> "an umbrella").
 *  - A filled word that opens the line is capitalized.
 * The same blank id always yields the same word.
 */
export function renderSegs(text: string, fills: Record<string, Fill>): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(PH)) {
    let before = text.slice(last, m.index);
    const f = fills[m[1]];
    let word = f?.word ?? '???';
    if (segs.length === 0 && /^[^A-Za-z0-9]*$/.test(before)) word = capFirst(word); // first word of the line
    before = before.replace(/\b(an?)(\s+)$/i, (_, art: string, space: string) => withCase(art, articleFor(word)) + space);
    if (before) segs.push({ t: before });
    segs.push({ w: word, by: f?.by ?? null, auto: Boolean(f?.auto) });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ t: text.slice(last) });
  return segs;
}

export const renderPlain = (text: string, fills: Record<string, Fill>) =>
  renderSegs(text, fills)
    .map((s) => ('t' in s ? s.t : s.w))
    .join('');

// ---------------------------------------------------------------- dealing
/** Index of the first line each blank appears on (to keep dealing spread across the script). */
export function firstAppearance(lines: Line[]): Map<string, number> {
  const first = new Map<string, number>();
  lines.forEach((l, i) => {
    for (const m of l.text.matchAll(PH)) if (!first.has(m[1])) first.set(m[1], i);
  });
  return first;
}

export interface DealResult {
  /** playerId -> the blank ids that player writes. */
  assign: Record<string, string[]>;
  /** Free blanks nobody writes (cap or uneven count): filled with their default word. */
  undealt: string[];
  /** Words each player who got any has to write. Every dealt player gets exactly this many. */
  wordsEach: number;
}

/**
 * Deal the free blanks fairly:
 *  - F free blanks, N players. Words each = floor(F / N), capped at `maxWords`.
 *  - If N > F, a random subset of players gets 1 word each; everyone else uses defaults.
 *  - Every player who is dealt anything gets the SAME number of words.
 *  - The script is split into W bands (consecutive chunks of blanks); each band is shuffled and dealt
 *    round-robin, so each player's words come from different parts of the script.
 *  - Blanks that aren't dealt (cap / remainder) are spaced evenly through the script, not clumped.
 * Script length never depends on the player count.
 */
export function dealBlanks(t: Template, playerIds: string[], opts: { maxWords: number; useNames: boolean }): DealResult {
  const free = t.blanks.filter((b) => b.kind === 'free' || (!opts.useNames && b.kind === 'roster'));
  const N = playerIds.length;
  const F = free.length;
  if (!N || !F) return { assign: {}, undealt: free.map((b) => b.id), wordsEach: 0 };

  const first = firstAppearance(t.lines);
  const ordered = [...free].sort((a, b) => (first.get(a.id) ?? 1e9) - (first.get(b.id) ?? 1e9));

  let wordsEach = Math.min(Math.max(1, Math.floor(opts.maxWords)), Math.floor(F / N));
  let takers = shuffle(playerIds);
  if (wordsEach < 1) {
    wordsEach = 1; // more players than blanks: one word for a random subset
    takers = takers.slice(0, F);
  }
  const dealtCount = wordsEach * takers.length;
  const chosen = dealtCount >= F ? ordered : Array.from({ length: dealtCount }, (_, i) => ordered[Math.floor((i * F) / dealtCount)]);

  const assign: Record<string, string[]> = {};
  for (const p of takers) assign[p] = [];
  for (let band = 0; band < wordsEach; band++) {
    const slice = shuffle(chosen.slice(band * takers.length, (band + 1) * takers.length));
    slice.forEach((b, i) => assign[takers[i]].push(b.id));
  }
  const dealt = new Set(chosen.map((b) => b.id));
  return { assign, undealt: free.filter((b) => !dealt.has(b.id)).map((b) => b.id), wordsEach };
}
