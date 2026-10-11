/** Normalize free text for comparison: case, accents, punctuation, articles, plurals. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['the', 'a', 'an', 'of'].includes(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** True when two answers are the same thing, give or take typos, plurals, and word order. */
export function tooClose(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb || na.replace(/ /g, '') === nb.replace(/ /g, '')) return true;
  const longest = Math.max(na.length, nb.length);
  if (1 - levenshtein(na, nb) / longest >= 0.8 && longest >= 4) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  if (ta.size > 1 || tb.size > 1) {
    const inter = [...ta].filter((w) => tb.has(w)).length;
    const union = new Set([...ta, ...tb]).size;
    if (inter / union >= 0.75) return true;
  }
  return false;
}
