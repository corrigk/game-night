import { CAP_VOTE_POINTS, REASON, WF_FOOLED_POINTS } from '../games/reasons';
import { supabase } from '../lib/supabase';
import type { Player } from '../lib/types';

export interface Award {
  id: string;
  title: string;
  emoji: string;
  playerIds: string[];
  detail: string;
}

/** Players holding the highest positive value (ties all win). */
function topOf(values: Map<string, number>): { ids: string[]; value: number } | null {
  let max = 0;
  for (const v of values.values()) max = Math.max(max, v);
  if (max <= 0) return null;
  return { ids: [...values].filter(([, v]) => v === max).map(([id]) => id), value: max };
}

const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);

/** Build the silly superlatives from everything that happened in the room. */
export async function computeAwards(roomId: string, players: Player[]): Promise<Award[]> {
  const ids = new Set(players.map((p) => p.id));
  const [events, votes, subs, runs] = await Promise.all([
    supabase.from('score_events').select('player_id, points, reason').eq('room_id', roomId),
    supabase.from('votes').select('run_id, round, kind, target_submission_id, target_player_id').eq('room_id', roomId),
    supabase.from('submissions').select('id, player_id, payload').eq('room_id', roomId).eq('kind', 'caption'),
    supabase.from('game_runs').select('id, game_type').eq('room_id', roomId),
  ]);

  const byReason = (match: (r: string) => boolean, per: (points: number) => number = () => 1) => {
    const m = new Map<string, number>();
    for (const e of events.data ?? []) if (ids.has(e.player_id) && match(e.reason)) add(m, e.player_id, per(e.points));
    return m;
  };

  const out: Award[] = [];
  const push = (id: string, title: string, emoji: string, top: { ids: string[]; value: number } | null, detail: (v: number) => string) => {
    if (top) out.push({ id, title, emoji, playerIds: top.ids, detail: detail(top.value) });
  };

  push('liar', 'Best Liar', '🤥', topOf(byReason((r) => r === REASON.wfFooled, (p) => p / WF_FOOLED_POINTS)),
    (n) => `Fooled ${n} ${n === 1 ? 'person' : 'people'} with fake facts`);
  push('truth', 'Human Lie Detector', '🕵️', topOf(byReason((r) => r === REASON.wfTruth)),
    (n) => `Found the truth ${n} time${n === 1 ? '' : 's'}`);

  // Funniest caption: the single caption with the most votes.
  const capVotes = new Map<string, number>();
  for (const v of votes.data ?? []) if (v.kind === 'cap' && v.target_submission_id) add(capVotes, v.target_submission_id, 1);
  const bestCap = [...capVotes].sort((a, b) => b[1] - a[1])[0];
  const capSub = bestCap && (subs.data ?? []).find((s) => s.id === bestCap[0]);
  if (capSub?.player_id && ids.has(capSub.player_id)) {
    out.push({
      id: 'caption', title: 'Funniest Caption', emoji: '😂', playerIds: [capSub.player_id],
      detail: `"${String((capSub.payload as { text?: string }).text ?? '')}" (${bestCap[1]} vote${bestCap[1] === 1 ? '' : 's'})`,
    });
  } else {
    push('caption', 'Funniest Caption', '😂', topOf(byReason((r) => r === REASON.capVotes, (p) => p / CAP_VOTE_POINTS)), (n) => `Collected ${n} caption votes`);
  }

  // Most Likely Winner: most often named the winner in Most Likely To.
  const mltRuns = new Set((runs.data ?? []).filter((r) => r.game_type === 'most_likely').map((r) => r.id));
  const perRound = new Map<string, Map<string, number>>();
  for (const v of votes.data ?? []) {
    if (v.kind !== 'mlt' || !v.target_player_id || !mltRuns.has(v.run_id)) continue;
    const key = `${v.run_id}:${v.round}`;
    if (!perRound.has(key)) perRound.set(key, new Map());
    add(perRound.get(key)!, v.target_player_id, 1);
  }
  const mltWins = new Map<string, number>();
  for (const tally of perRound.values()) {
    const top = topOf(tally);
    if (top) for (const id of top.ids) if (ids.has(id)) add(mltWins, id, 1);
  }
  push('mlt', 'Most Likely Winner', '👉', topOf(mltWins), (n) => `Named "most likely" ${n} time${n === 1 ? '' : 's'}`);
  push('mind', 'Mind Reader', '🔮', topOf(byReason((r) => r === REASON.mltMatch)), (n) => `Matched the majority ${n} time${n === 1 ? '' : 's'}`);
  push('tap', 'Quickest Draw', '⚡', topOf(byReason((r) => r === REASON.tapWin)), (n) => `Fastest tap ${n} time${n === 1 ? '' : 's'}`);
  push('zillow', 'Dream Home Hunter', '🏠', topOf(byReason((r) => r === REASON.zilFinal, (p) => (p >= 400 ? 1 : 0))), (n) => `Won ${n} Zillow final${n === 1 ? '' : 's'}`);
  push('talent', 'Star Performer', '🎭', topOf(byReason((r) => r === REASON.talent, (p) => p)), (n) => `${n} talent points`);

  // Last place gets a trophy too (only if there are enough players for it to be funny).
  const ranked = [...players].sort((a, b) => b.score - a.score);
  if (ranked.length >= 4) {
    const last = ranked[ranked.length - 1];
    out.push({ id: 'participation', title: 'Participation Trophy', emoji: '🎗️', playerIds: [last.id], detail: 'It is about the journey. Mostly.' });
  }
  return out;
}
