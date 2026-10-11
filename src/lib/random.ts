export function shuffle<T>(list: readonly T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Draw the next item from a shuffled deck, reshuffling when it runs out. */
export function draw<T>(deck: T[], cursor: number): { item: T; deck: T[]; cursor: number } {
  let d = deck;
  let c = cursor;
  if (c >= d.length) {
    d = shuffle(d);
    c = 0;
  }
  return { item: d[c], deck: d, cursor: c + 1 };
}
