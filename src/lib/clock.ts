import { supabase } from './supabase';

let offsetMs = 0;

/** Estimate server-minus-local clock offset so every screen shows the same timer. */
export async function syncClock(): Promise<void> {
  try {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('server_now');
      const t1 = Date.now();
      if (error || !data) continue;
      samples.push(new Date(data as string).getTime() - (t0 + t1) / 2);
    }
    if (samples.length) offsetMs = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  } catch {
    // Fall back to the local clock.
  }
}

export const serverNow = () => Date.now() + offsetMs;

export function secondsLeft(endsAt: string | null): number | null {
  if (!endsAt) return null;
  return Math.max(0, (new Date(endsAt).getTime() - serverNow()) / 1000);
}
