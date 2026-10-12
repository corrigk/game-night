import { shuffle } from './random';
import { supabase } from './supabase';

export type BankTable =
  | 'facts'
  | 'most_likely_prompts'
  | 'caption_cards'
  | 'caption_images'
  | 'story_seeds'
  | 'zillow_prompts'
  | 'talents'
  | 'emoji_titles'
  | 'dolphin_tasks'
  | 'hot_seat_words';

export interface BankRow {
  id: string;
  times_used?: number | null;
  vetoed?: boolean | null;
}

/** All non-vetoed rows of a bank. Tolerates the usage columns not existing yet. */
export async function loadBank<T extends BankRow>(table: BankTable): Promise<T[]> {
  const { data } = await supabase.from(table).select('*');
  return ((data ?? []) as T[]).filter((r) => !r.vetoed);
}

/** Shuffled, then least-used first, so repeat nights get fresh material before repeats. */
export function leastUsed<T extends BankRow>(rows: T[]): T[] {
  return shuffle(rows).sort((a, b) => (a.times_used ?? 0) - (b.times_used ?? 0));
}

/** Fire-and-forget usage counter; silently does nothing if the migration hasn't run. */
export function markUsed(table: BankTable, ids: (string | undefined | null)[]) {
  const real = ids.filter((x): x is string => Boolean(x));
  if (real.length) void supabase.rpc('bump_used', { p_table: table, p_ids: real });
}

export interface CurrentItem {
  table: BankTable;
  id: string;
}
