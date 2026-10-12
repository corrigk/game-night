import { useEffect, useRef, useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { draw, shuffle } from '../../lib/random';
import { play } from '../../lib/sound';
import { errorCode } from '../../lib/supabase';
import { teamOf } from '../../lib/teams';
import { useTeams } from '../../lib/teamsContext';
import type { Room, Team } from '../../lib/types';
import { REASON } from '../reasons';
import type { GameCtx, GameModule, HostControlsProps, PhoneGameProps, TVGameProps } from '../types';
import { HOT_SEAT_CONFIG as C } from './config';

/**
 * Hot Seat (teams). A guesser stands with their back to the TV. Their teammates describe the card's
 * target word without saying any of the 3 forbidden words. Opponents can BUZZ rule violations.
 * One engine "round" is one TURN, so a host-visible round is (number of teams) turns.
 *
 * Secrecy: cards live only in game_runs.state (host-only) and are drawn on the TV, which faces away
 * from the guesser. Phones never receive card text, so the guesser's phone can't leak it.
 */

interface Card {
  id?: string;
  word: string;
  forbidden: string[];
  category?: string;
}
interface Ev {
  kind: 'got' | 'skip' | 'buzz' | 'override';
  round: number;
  teamId: string;
  delta: number;
  by: string | null;
}
interface RunState {
  deck?: Card[];
  cursor?: number;
  current?: Card;
  cardIdx?: number;
  scores?: Record<string, number>;
  turnCounts?: Record<string, number>;
  skipsUsed?: number;
  history?: Ev[];
  mvp?: Record<string, number>;
  lastBuzz?: Record<string, number>;
  finished?: boolean;
}

const FALLBACK: Card[] = [
  { word: 'Pizza', forbidden: ['cheese', 'pepperoni', 'slice'] },
  { word: 'Umbrella', forbidden: ['rain', 'wet', 'open'] },
  { word: 'Penguin', forbidden: ['waddle', 'Antarctica', 'tuxedo'] },
  { word: 'Church', forbidden: ['pew', 'Mass', 'pray'] },
];

const rs = (ctx: GameCtx) => ctx.run.state as RunState;
const pubScores = (ctx: GameCtx) => rs(ctx).scores ?? {};
const members = (ctx: GameCtx, teamId: string) => ctx.players.filter((p) => p.team_id === teamId);
const turnEvents = (ctx: GameCtx) => (rs(ctx).history ?? []).filter((e) => e.round === ctx.room.round);

async function drawCard(ctx: GameCtx): Promise<Card> {
  const st = rs(ctx);
  const d = draw(st.deck?.length ? st.deck : FALLBACK, st.cursor ?? 0);
  markUsed('hot_seat_words', [d.item.id]);
  await ctx.saveRun({ deck: d.deck, cursor: d.cursor, current: d.item, cur: d.item.id ? { table: 'hot_seat_words', id: d.item.id } : null });
  return d.item;
}

/** Shared public fields for every step of a turn. */
const base = (ctx: GameCtx, extra: Record<string, unknown> = {}) => ({
  teamId: ctx.room.state.teamId,
  guesserId: ctx.room.state.guesserId,
  turnsPerRound: ctx.room.state.turnsPerRound,
  scores: pubScores(ctx),
  hideStrip: true,
  ...extra,
});

async function beginTurn(ctx: GameCtx) {
  await ctx.saveRun({ cardIdx: 0, skipsUsed: 0 });
  await drawCard(ctx);
  await ctx.setStep('turn', base(ctx, { n: 0, skipsLeft: C.skipsPerTurn, flashAt: null }), {
    seconds: C.turnSeconds,
    submit: ['got', 'skip', 'buzz'],
    count: [],
  });
}

async function applyEvent(ctx: GameCtx, ev: Ev) {
  const st = rs(ctx);
  const scores = { ...(st.scores ?? {}) };
  scores[ev.teamId] = (scores[ev.teamId] ?? 0) + ev.delta;
  const mvp = { ...(st.mvp ?? {}) };
  if ((ev.kind === 'got') && ev.by) mvp[ev.by] = (mvp[ev.by] ?? 0) + 1;
  await ctx.saveRun({
    scores,
    mvp,
    history: [...(st.history ?? []), ev],
    skipsUsed: (st.skipsUsed ?? 0) + (ev.kind === 'skip' ? 1 : 0),
  });
}

async function advanceCard(ctx: GameCtx, extra: Record<string, unknown> = {}) {
  await drawCard(ctx);
  const st = rs(ctx);
  const n = (st.cardIdx ?? 0) + 1;
  await ctx.saveRun({ cardIdx: n });
  await ctx.patchState({ n, skipsLeft: Math.max(0, C.skipsPerTurn - (st.skipsUsed ?? 0)), scores: pubScores(ctx), ...extra });
}

async function showSummary(ctx: GameCtx) {
  const ev = turnEvents(ctx);
  await ctx.setStep(
    'summary',
    base(ctx, {
      got: ev.filter((e) => e.kind === 'got' || e.kind === 'override').length,
      skips: ev.filter((e) => e.kind === 'skip').length,
      buzzes: ev.filter((e) => e.kind === 'buzz').length,
      net: ev.reduce((s, e) => s + e.delta, 0),
    }),
    { seconds: C.summarySeconds },
  );
}

export const hotSeat: GameModule = {
  id: 'hot_seat',
  title: 'Hot Seat',
  emoji: '🔥',
  tagline: 'Describe it. Do not say the forbidden words.',
  rules: [
    'One teammate is the guesser: back to the TV. Everyone else describes the word.',
    'Never say the target word, a forbidden word, or use gestures.',
    'Other teams: BUZZ if you catch a violation. It voids the card.',
    '+1 per word, -1 per skip. The winning team gets bonus points.',
  ],
  scored: true,
  needsTeams: true,
  defaultRounds: C.defaultRounds,
  maxRounds: C.maxRounds,
  turnsPerRound: (teamCount) => Math.max(2, teamCount),
  progressLabel: (room: Room) => {
    const per = Math.max(1, Number(room.state.turnsPerRound ?? 2));
    return `Round ${Math.ceil(room.round / per)}/${Math.ceil(room.rounds_total / per)} · Turn ${room.round}/${room.rounds_total}`;
  },
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & Card>('hot_seat_words');
    const deck: Card[] = rows.length
      ? leastUsed(rows).map((r) => ({ id: r.id, word: String(r.word), forbidden: ((r.forbidden as string[] | null) ?? []).map(String), category: String(r.category ?? '') }))
      : shuffle(FALLBACK);
    await ctx.saveRun({ deck, cursor: 0, scores: {}, turnCounts: {}, history: [], mvp: {}, lastBuzz: {}, finished: false });
  },

  async startRound(ctx) {
    const teams = ctx.teams;
    const T = teams.length;
    const team = teams[(ctx.room.round - 1) % T];
    const crew = members(ctx, team.id);
    if (crew.length < 2) {
      // A one-person team can't describe to anyone: skip its turn.
      return ctx.setStep('ready', { teamId: team.id, guesserId: null, skipped: true, turnsPerRound: T, scores: pubScores(ctx), hideStrip: true });
    }
    const counts = { ...(rs(ctx).turnCounts ?? {}) };
    const n = counts[team.id] ?? 0;
    const guesser = crew[n % crew.length]; // rotates through the team each time it goes
    counts[team.id] = n + 1;
    await ctx.saveRun({ turnCounts: counts });
    await ctx.setStep('ready', { teamId: team.id, guesserId: guesser.id, turnsPerRound: T, scores: pubScores(ctx), hideStrip: true });
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'ready') return ctx.room.state.skipped ? ctx.endRound() : beginTurn(ctx);
    if (step === 'turn') return showSummary(ctx);
    return ctx.endRound(); // summary
  },

  /** Phone taps: describers "Got it!"/"Skip", opponents "BUZZ". The first valid one for the current card wins. */
  async process(ctx) {
    if (ctx.room.state.step !== 'turn') return;
    const n = Number(ctx.room.state.n ?? 0);
    const teamId = String(ctx.room.state.teamId ?? '');
    const guesserId = String(ctx.room.state.guesserId ?? '');
    const st = rs(ctx);
    const now = Date.now();
    const taps = ctx
      .roundSubs()
      .filter((s) => ['got', 'skip', 'buzz'].includes(s.kind) && Number(s.payload.n) === n)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));

    for (const s of taps) {
      const p = ctx.players.find((x) => x.id === s.player_id);
      if (!p?.team_id) continue;
      if (s.kind === 'got' && p.team_id === teamId && p.id !== guesserId) {
        await applyEvent(ctx, { kind: 'got', round: ctx.room.round, teamId, delta: C.pointPerWord, by: p.id });
        return advanceCard(ctx);
      }
      if (s.kind === 'skip' && p.team_id === teamId && p.id !== guesserId && (st.skipsUsed ?? 0) < C.skipsPerTurn) {
        await applyEvent(ctx, { kind: 'skip', round: ctx.room.round, teamId, delta: -C.skipPenalty, by: p.id });
        return advanceCard(ctx);
      }
      if (s.kind === 'buzz' && p.team_id !== teamId) {
        const last = st.lastBuzz?.[p.id] ?? 0;
        if (now - last < C.buzzCooldownSeconds * 1000) continue;
        await ctx.saveRun({ lastBuzz: { ...(st.lastBuzz ?? {}), [p.id]: now } });
        await applyEvent(ctx, { kind: 'buzz', round: ctx.room.round, teamId, delta: 0, by: p.id });
        return advanceCard(ctx, { flashAt: now });
      }
    }
  },

  /** Host drawer / keys. */
  async action(ctx, name) {
    if (ctx.room.state.step !== 'turn') return;
    const teamId = String(ctx.room.state.teamId ?? '');
    if (name === 'enter' || name === 'got') {
      await applyEvent(ctx, { kind: 'override', round: ctx.room.round, teamId, delta: C.pointPerWord, by: null });
      return advanceCard(ctx);
    }
    if (name === 'skipCard') return advanceCard(ctx); // host skip: no penalty
    if (name === 'undo') {
      const st = rs(ctx);
      const history = [...(st.history ?? [])];
      const i = history.map((e) => e.round === ctx.room.round && e.delta !== 0).lastIndexOf(true);
      if (i < 0) return;
      const [ev] = history.splice(i, 1);
      const scores = { ...(st.scores ?? {}) };
      scores[ev.teamId] = (scores[ev.teamId] ?? 0) - ev.delta;
      const mvp = { ...(st.mvp ?? {}) };
      if (ev.kind === 'got' && ev.by) mvp[ev.by] = Math.max(0, (mvp[ev.by] ?? 0) - 1);
      await ctx.saveRun({ history, scores, mvp, skipsUsed: Math.max(0, (st.skipsUsed ?? 0) - (ev.kind === 'skip' ? 1 : 0)) });
      await ctx.patchState({ scores, skipsLeft: Math.max(0, C.skipsPerTurn - Math.max(0, (st.skipsUsed ?? 0) - (ev.kind === 'skip' ? 1 : 0))) });
    }
  },

  /** Winning team (ties: both) gets a bonus on each member's individual score. */
  async onFinish(ctx) {
    const st = rs(ctx);
    if (st.finished) return;
    const scores = st.scores ?? {};
    const best = Math.max(0, ...ctx.teams.map((t) => scores[t.id] ?? 0));
    await ctx.saveRun({ finished: true });
    if (best <= 0) return;
    const winners = ctx.teams.filter((t) => (scores[t.id] ?? 0) === best);
    await ctx.award(
      winners.flatMap((t) => members(ctx, t.id).map((p) => ({ playerId: p.id, points: C.winnerBonus, reason: REASON.hotSeatWinner }))),
    );
  },

  HostControls: HotSeatControls,
  TV: HotSeatTV,
  Phone: HotSeatPhone,
};

// ---------------------------------------------------------------- host drawer
function HotSeatControls({ room, engine }: HostControlsProps) {
  const live = room.state.step === 'turn';
  return (
    <div className="stack gap">
      <div className="drawer-grid">
        <button className="btn btn-primary" disabled={!live} onClick={() => void engine.gameAction('got')}>✓ Got it <kbd>Enter</kbd></button>
        <button className="btn" disabled={!live} onClick={() => void engine.gameAction('skipCard')}>Skip card (free)</button>
        <button className="btn" disabled={!live} onClick={() => void engine.gameAction('undo')}>↶ Undo last point</button>
      </div>
      <p className="dim small">Pause the turn timer with <kbd>P</kbd>. <kbd>Enter</kbd> overrides a Got it.</p>
    </div>
  );
}

// ---------------------------------------------------------------- TV
function TeamBoard({ scores, activeId }: { scores: Record<string, number>; activeId?: string }) {
  const teams = useTeams();
  return (
    <div className="hs-board">
      {teams.map((t) => (
        <div key={t.id} className={`hs-team${t.id === activeId ? ' hs-team-active' : ''}`} style={{ ['--tc' as string]: t.color }}>
          <span>{t.name}</span>
          <b>{scores[t.id] ?? 0}</b>
        </div>
      ))}
    </div>
  );
}

function useTeamById(id: unknown): Team | undefined {
  return useTeams().find((t) => t.id === id);
}

function HotSeatTV({ room, players, run }: TVGameProps) {
  const step = room.state.step;
  const team = useTeamById(room.state.teamId);
  const guesser = players.find((p) => p.id === room.state.guesserId);
  const scores = (room.state.scores ?? {}) as Record<string, number>;
  const card = (run?.state as RunState | undefined)?.current;
  const flashAt = Number(room.state.flashAt ?? 0);
  const lastFlash = useRef(0);

  useEffect(() => {
    if (flashAt && flashAt !== lastFlash.current) {
      if (Date.now() - flashAt < 3000) play('sting');
      lastFlash.current = flashAt;
    }
  }, [flashAt]);

  if (!team) return <div className="center-stack"><div className="spinner" /></div>;
  const style = { ['--tc' as string]: team.color };

  if (step === 'ready') {
    if (room.state.skipped) {
      return (
        <div className="center-stack">
          <h1 className="display" style={{ color: team.color }}>{team.name}</h1>
          <p className="lead">needs at least 2 players to take a turn. Skipping.</p>
          <p className="tv-footer"><kbd>Space</kbd> to continue</p>
        </div>
      );
    }
    const crew = players.filter((p) => p.team_id === team.id && p.id !== guesser?.id);
    return (
      <div className="center-stack hs-stage" style={style}>
        <TeamBoard scores={scores} activeId={team.id} />
        <h1 className="display hs-team-name">{team.name}</h1>
        {guesser && (
          <>
            <p className="lead">Guesser, stand in front of the TV with your back to it:</p>
            <PlayerChip player={guesser} size="xl" />
          </>
        )}
        <p className="lead">
          Describers: {crew.map((p) => p.name).join(', ')}. No forbidden words, no gestures!
        </p>
        <p className="tv-footer"><kbd>Space</kbd> starts the {C.turnSeconds}s turn</p>
      </div>
    );
  }

  if (step === 'turn') {
    return (
      <div className="hs-stage hs-turn" style={style}>
        {flashAt > 0 && Date.now() - flashAt < 1800 && (
          <div key={flashAt} className="buzz-flash">🚫 BUZZED! 🚫</div>
        )}
        <div className="hs-top">
          <TeamBoard scores={scores} activeId={team.id} />
          {guesser && (
            <div className="row gap">
              <span className="lead dim">Guesser:</span>
              <PlayerChip player={guesser} size="lg" />
            </div>
          )}
        </div>
        {card ? (
          <div className="hs-card pop-in" key={String(room.state.n)}>
            <div className="hs-word">{card.word}</div>
            <div className="hs-forbidden-label">DO NOT SAY</div>
            <div className="hs-forbidden">
              {card.forbidden.map((f) => (
                <span key={f} className="hs-forbidden-word">{f}</span>
              ))}
            </div>
          </div>
        ) : (
          <div className="spinner" />
        )}
        <p className="lead dim">Enter = got it · skips left: {Number(room.state.skipsLeft ?? 0)}</p>
      </div>
    );
  }

  return (
    <div className="center-stack hs-stage" style={style}>
      <h1 className="display" style={{ color: team.color }}>{team.name}: turn over!</h1>
      {guesser && <PlayerChip player={guesser} size="lg" />}
      <div className="hs-stats">
        <div><b>{Number(room.state.got ?? 0)}</b><span>words</span></div>
        <div><b>{Number(room.state.skips ?? 0)}</b><span>skips</span></div>
        <div><b>{Number(room.state.buzzes ?? 0)}</b><span>buzzes</span></div>
        <div><b>{Number(room.state.net ?? 0) >= 0 ? '+' : ''}{Number(room.state.net ?? 0)}</b><span>net</span></div>
      </div>
      <TeamBoard scores={scores} activeId={team.id} />
    </div>
  );
}

// ---------------------------------------------------------------- phone
function HotSeatPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const teams = useTeams();
  const myTeam = teamOf(teams, me);
  const activeTeamId = String(room.state.teamId ?? '');
  const activeTeam = teams.find((t) => t.id === activeTeamId);
  const guesserId = String(room.state.guesserId ?? '');
  const n = Number(room.state.n ?? 0);
  const skipsLeft = Number(room.state.skipsLeft ?? 0);
  const [err, setErr] = useState<string | null>(null);
  const [tapped, setTapped] = useState<string | null>(null); // `${kind}:${n}`
  const [coolUntil, setCoolUntil] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!coolUntil) return;
    const id = window.setInterval(() => tick((x) => x + 1), 250);
    return () => window.clearInterval(id);
  }, [coolUntil]);

  const send = (kind: 'got' | 'skip' | 'buzz') => {
    setErr(null);
    setTapped(`${kind}:${n}`);
    if (kind === 'buzz') setCoolUntil(Date.now() + C.buzzCooldownSeconds * 1000);
    if (navigator.vibrate) navigator.vibrate(40);
    api.submit(kind, { n }).catch((e) => setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Turn is over!' : errorCode(e)));
  };

  if (!myTeam) {
    return (
      <div className="phone-center center-stack">
        <h2>You're not on a team</h2>
        <p className="dim">Ask the host to add you to a team. Watch the TV for now.</p>
      </div>
    );
  }

  const isActive = myTeam.id === activeTeamId;
  const isGuesser = me.id === guesserId;
  const guesser = players.find((p) => p.id === guesserId);

  if (step === 'summary') {
    return (
      <div className="phone-center center-stack">
        <h2>{activeTeam?.name}: turn over</h2>
        <p className="lead">{Number(room.state.got ?? 0)} words · net {Number(room.state.net ?? 0) >= 0 ? '+' : ''}{Number(room.state.net ?? 0)}</p>
      </div>
    );
  }

  if (step === 'ready') {
    if (room.state.skipped) return <div className="phone-center"><h2>{activeTeam?.name} can't go (too few players)</h2></div>;
    return (
      <div className="phone-center center-stack">
        {isActive && isGuesser ? (
          <>
            <h1 className="display phone-title">You're the guesser!</h1>
            <p className="lead">Stand in front of the TV with your back to it. Your phone is off for this turn.</p>
          </>
        ) : isActive ? (
          <>
            <h1 className="display phone-title">Get ready to describe</h1>
            <p className="lead">{guesser?.name} is guessing. No forbidden words, no gestures.</p>
          </>
        ) : (
          <>
            <h1 className="display phone-title">{activeTeam?.name} is up</h1>
            <p className="lead">Watch the TV. Be ready to BUZZ any rule-breaking.</p>
          </>
        )}
      </div>
    );
  }

  // step === 'turn'
  if (isActive && isGuesser) {
    return (
      <div className="phone-center center-stack hs-phone-off">
        <h1 className="display phone-title">🙈 Eyes up, phone off</h1>
        <p className="lead">Face away from the TV and listen to your team.</p>
      </div>
    );
  }

  if (isActive) {
    return (
      <div className="stack gap hs-phone-turn">
        <p className="center dim">Look at the TV. You are describing for {guesser?.name}.</p>
        <button className="hs-btn hs-btn-got" disabled={tapped === `got:${n}`} onClick={() => send('got')}>
          ✓ GOT IT!
        </button>
        <button className="hs-btn hs-btn-skip" disabled={skipsLeft <= 0 || tapped === `skip:${n}`} onClick={() => send('skip')}>
          Skip (−{C.skipPenalty}) · {skipsLeft} left
        </button>
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  const cooling = Date.now() < coolUntil;
  return (
    <div className="stack gap hs-phone-turn">
      <p className="center dim">{activeTeam?.name} is describing. Catch them saying a forbidden word or gesturing!</p>
      <button className="hs-btn hs-btn-buzz" disabled={cooling} onClick={() => send('buzz')}>
        {cooling ? `…${Math.max(1, Math.ceil((coolUntil - Date.now()) / 1000))}` : 'BUZZ!'}
      </button>
      {err && <p className="error center">{err}</p>}
    </div>
  );
}
