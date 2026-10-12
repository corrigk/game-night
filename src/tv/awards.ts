import { CAP_VOTE_POINTS, REASON, WF_FOOLED_POINTS } from '../games/reasons';
import { GAMES } from '../games/registry';
import { supabase } from '../lib/supabase';
import { teamTotals } from '../lib/teams';
import type { Player, Team } from '../lib/types';

export interface Award {
  id: string;
  title: string;
  emoji: string;
  playerIds: string[];
  detail: string;
}

/** A standalone highlight for the recap ("the funniest caption of the night"). */
export interface Moment {
  emoji: string;
  title: string;
  text: string;
  by: string;
}

/** Self-contained snapshot stored in rooms.settings.recap so /recap works for anyone, any time. */
export interface Recap {
  at: string;
  players: { name: string; emoji: string; color: string; score: number }[];
  awards: { title: string; emoji: string; names: string[]; detail: string }[];
  moments: Moment[];
  teams: { name: string; emoji: string; color: string; total: number; members: string[] }[];
  games: string[];
}

/** Players holding the highest positive value (ties all win). */
function topOf(values: Map<string, number>): { ids: string[]; value: number } | null {
  let max = 0;
  for (const v of values.values()) max = Math.max(max, v);
  if (max <= 0) return null;
  return { ids: [...values].filter(([, v]) => v === max).map(([id]) => id), value: max };
}

const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);

interface SubRow {
  id: string;
  run_id: string;
  round: number;
  kind: string;
  player_id: string | null;
  payload: Record<string, unknown>;
}

/** Build the silly superlatives and recap highlights from everything that happened in the room. */
export async function computeNight(
  roomId: string,
  players: Player[],
  teamList: Team[],
): Promise<{ awards: Award[]; recap: Recap }> {
  const ids = new Set(players.map((p) => p.id));
  const byId = new Map(players.map((p) => [p.id, p]));
  const [events, votes, subsRes, runs] = await Promise.all([
    supabase.from('score_events').select('player_id, points, reason').eq('room_id', roomId),
    supabase.from('votes').select('run_id, round, kind, target_submission_id, target_player_id').eq('room_id', roomId),
    supabase.from('submissions').select('id, run_id, round, kind, player_id, payload').eq('room_id', roomId).in('kind', ['caption', 'rating']),
    supabase.from('game_runs').select('id, game_type, status, state').eq('room_id', roomId),
  ]);
  const subs = (subsRes.data ?? []) as SubRow[];

  const byReason = (match: (r: string) => boolean, per: (points: number) => number = () => 1) => {
    const m = new Map<string, number>();
    for (const e of events.data ?? []) if (ids.has(e.player_id) && match(e.reason)) add(m, e.player_id, per(e.points));
    return m;
  };

  const out: Award[] = [];
  const moments: Moment[] = [];
  const push = (id: string, title: string, emoji: string, top: { ids: string[]; value: number } | null, detail: (v: number) => string) => {
    if (top) out.push({ id, title, emoji, playerIds: top.ids, detail: detail(top.value) });
  };
  const nameOf = (id: string | null | undefined) => (id ? byId.get(id)?.name ?? 'Someone' : 'Someone');

  push('liar', 'Best Liar', '🤥', topOf(byReason((r) => r === REASON.wfFooled, (p) => p / WF_FOOLED_POINTS)),
    (n) => `Fooled ${n} ${n === 1 ? 'person' : 'people'} with fake facts`);
  push('truth', 'Human Lie Detector', '🕵️', topOf(byReason((r) => r === REASON.wfTruth)),
    (n) => `Found the truth ${n} time${n === 1 ? '' : 's'}`);

  // Funniest caption: the single caption with the most votes.
  const capVotes = new Map<string, number>();
  for (const v of votes.data ?? []) if (v.kind === 'cap' && v.target_submission_id) add(capVotes, v.target_submission_id, 1);
  const bestCap = [...capVotes].sort((a, b) => b[1] - a[1])[0];
  const capSub = bestCap && subs.find((s) => s.id === bestCap[0]);
  if (capSub?.player_id && ids.has(capSub.player_id)) {
    const text = String(capSub.payload.text ?? '');
    out.push({
      id: 'caption', title: 'Funniest Caption', emoji: '😂', playerIds: [capSub.player_id],
      detail: `"${text}" (${bestCap[1]} vote${bestCap[1] === 1 ? '' : 's'})`,
    });
    moments.push({ emoji: '😂', title: 'Funniest caption', text: `"${text}"`, by: nameOf(capSub.player_id) });
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
  push('encore', 'Crowd Favorite', '👏', topOf(byReason((r) => r === REASON.talentEncore, (p) => p / 50)), (n) => `Earned ${n} encore${n === 1 ? '' : 's'}`);

  // Highlights from per-run history.
  let bestLie: { text: string; by: string; fooled: number; prompt: string } | null = null;
  for (const r of runs.data ?? []) {
    if (r.game_type !== 'weird_facts') continue;
    const hist = ((r.state as { history?: { prompt: string; text: string; authorId: string | null; fooled: number }[] }).history ?? []);
    for (const h of hist) if (h.fooled > (bestLie?.fooled ?? 0)) bestLie = { text: h.text, by: nameOf(h.authorId), fooled: h.fooled, prompt: h.prompt };
  }
  if (bestLie) moments.push({ emoji: '🤥', title: 'Best lie', text: `"${bestLie.text}" fooled ${bestLie.fooled}`, by: bestLie.by });

  let bestTalent: { text: string; by: string; avg: number } | null = null;
  for (const r of runs.data ?? []) {
    if (r.game_type !== 'talent_show') continue;
    const st = r.state as { order?: string[]; talents?: Record<string, string> };
    const order = st.order ?? [];
    const rounds = new Map<number, number[]>();
    for (const s of subs) if (s.run_id === r.id && s.kind === 'rating') rounds.set(s.round, [...(rounds.get(s.round) ?? []), Number(s.payload.stars) || 0]);
    for (const [round, stars] of rounds) {
      const performer = order[(round - 1) % Math.max(order.length, 1)];
      const avg = stars.reduce((a, b) => a + b, 0) / stars.length;
      if (performer && avg > (bestTalent?.avg ?? 0)) bestTalent = { text: st.talents?.[performer] ?? '', by: nameOf(performer), avg };
    }
  }
  if (bestTalent?.text) moments.push({ emoji: '🎭', title: 'Top talent', text: `${bestTalent.text} (${bestTalent.avg.toFixed(1)}★)`, by: bestTalent.by });

  // Team champions, when teams are on.
  const teams = teamTotals(players, teamList);
  if (teams.length && teams[0].total > 0) {
    out.unshift({
      id: 'team', title: 'Team Champions', emoji: teams[0].emoji, playerIds: teams[0].members.map((m) => m.id),
      detail: `${teams[0].name}: ${teams[0].total.toLocaleString()} points`,
    });
  }

  // Last place gets a trophy too (only if there are enough players for it to be funny).
  const ranked = [...players].sort((a, b) => b.score - a.score);
  if (ranked.length >= 4) {
    const last = ranked[ranked.length - 1];
    out.push({ id: 'participation', title: 'Participation Trophy', emoji: '🎗️', playerIds: [last.id], detail: 'It is about the journey. Mostly.' });
  }

  const recap: Recap = {
    at: new Date().toISOString(),
    players: ranked.map((p) => ({ name: p.name, emoji: p.emoji, color: p.color, score: p.score })),
    awards: out.map((a) => ({ title: a.title, emoji: a.emoji, names: a.playerIds.map(nameOf), detail: a.detail })),
    moments,
    teams: teamList.length
      ? teams.map((t) => ({ name: t.name, emoji: t.emoji, color: t.color, total: t.total, members: t.members.map((m) => m.name) }))
      : [],
    games: [...new Set((runs.data ?? []).map((r) => GAMES[r.game_type]?.title).filter((t): t is string => Boolean(t)))],
  };
  return { awards: out, recap };
}
