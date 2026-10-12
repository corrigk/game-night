import { useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { shuffle } from '../../lib/random';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { errorCode } from '../../lib/supabase';
import { REASON } from '../reasons';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';

/**
 * Talent Show. Everyone is secretly assigned an absurd talent they cannot possibly do and gets
 * a few minutes to prepare. Then, one act per round, each performer is announced with their
 * talent, performs live, and the audience rates them 1-5 stars. Score = average stars × 100.
 *
 * Talents are private ('talent' rows only the owner can read) until that performer's turn.
 */

const PREP_SECONDS = 120;
const PERFORM_SECONDS = 60;
const RATE_SECONDS = 20;
const POINTS_PER_STAR = 100;
const ENCORE_POINTS = 50;

const FALLBACK_TALENTS = [
  'Juggle three household objects while reciting the alphabet backwards',
  'Perform an interpretive dance of a tax audit',
  'Do a dramatic nature-documentary narration of a person eating a sandwich',
  'Sing the national anthem as an opera, but only using the word "meow"',
  'Perform a magic trick that definitely fails, with total confidence',
  'Be a professional wrestling announcer introducing a houseplant',
  'Do a slow-motion replay of yourself sneezing, live',
  'Teach everyone a new language you invent on the spot',
  'Perform a one-person Shakespearean play using only a coat and a chair',
  'Do a ventriloquist act with no dummy',
  'Give a heartfelt motivational speech to a lukewarm cup of coffee',
  'Perform a rap about the history of the stapler',
  'Be a weather reporter forecasting the mood of the room',
  'Do an impression of a microwave that is having a bad day',
  'Hold a seance for a missing sock',
  'Perform a dramatic slow-motion chase scene alone',
];

interface RunState {
  order?: string[];
  talents?: Record<string, string>;
  talentIds?: Record<string, string>;
  spare?: { id?: string; text: string }[];
}
interface Reveal {
  performerId: string;
  talent: string;
  avg: number;
  count: number;
  points: number;
  encores: number;
}

const performerAt = (ctx: GameCtx, round: number) => {
  const order = (ctx.run.state as RunState).order ?? [];
  const here = new Set(ctx.players.map((p) => p.id));
  for (let k = 0; k < order.length; k++) {
    const id = order[(round - 1 + k) % order.length];
    if (here.has(id)) return id;
  }
  return null;
};

async function announce(ctx: GameCtx) {
  const performerId = performerAt(ctx, ctx.room.round);
  if (!performerId) return ctx.endRound();
  const st = ctx.run.state as RunState;
  const talent = st.talents?.[performerId] ?? '';
  const id = st.talentIds?.[performerId];
  await ctx.saveRun({ cur: id ? { table: 'talents', id } : null });
  await ctx.setStep('announce', { performerId, talent });
}

export const talentShow: GameModule = {
  id: 'talent_show',
  title: 'Talent Show',
  emoji: '🎭',
  tagline: 'You have a talent. It is absurd. You cannot do it.',
  rules: [
    'Everyone secretly gets an absurd talent they definitely cannot do.',
    'You get 2 minutes to prepare. Commit completely.',
    'One by one, perform live. The audience rates you 1-5 stars.',
  ],
  scored: true,
  defaultRounds: 6,
  maxRounds: 20,
  status: 'ready',

  async setup(ctx) {
    const rows = (await loadBank<BankRow & { text: string }>('talents')).filter((r) => String(r.text).trim());
    const deck: { id?: string; text: string }[] =
      rows.length >= 2 ? leastUsed(rows).map((r) => ({ id: r.id, text: String(r.text) })) : shuffle(FALLBACK_TALENTS).map((text) => ({ text }));
    const order = shuffle(ctx.players.map((p) => p.id));
    const assigned: Record<string, string> = {};
    const ids: Record<string, string> = {};
    order.forEach((pid, i) => {
      const t = deck[i % deck.length];
      assigned[pid] = t.text;
      if (t.id) ids[pid] = t.id;
    });
    markUsed('talents', Object.values(ids));
    await ctx.saveRun({ order, talents: assigned, talentIds: ids, spare: deck.slice(order.length) });
  },

  async startRound(ctx) {
    const talents = (ctx.run.state as RunState).talents ?? {};
    await ctx.addSubs(
      ctx.players.filter((p) => talents[p.id]).map((p) => ({ kind: 'talent', player_id: p.id, payload: { talent: talents[p.id] } })),
    );
    if (ctx.room.round === 1) return ctx.setStep('prep', {}, { seconds: PREP_SECONDS });
    return announce(ctx);
  },

  async next(ctx) {
    const state = ctx.room.state;
    const performerId = String(state.performerId ?? '');
    const talent = String(state.talent ?? '');
    switch (state.step) {
      case 'prep':
        return announce(ctx);
      case 'announce':
        return ctx.setStep('perform', { performerId, talent }, { seconds: PERFORM_SECONDS });
      case 'perform':
        return ctx.setStep('rate', { performerId, talent }, { seconds: RATE_SECONDS, submit: ['rating', 'encore'], count: ['rating'] });
      case 'rate': {
        const ratings = ctx.roundSubs('rating').filter((s) => s.player_id !== performerId);
        const stars = ratings.map((s) => Math.min(5, Math.max(1, Number(s.payload.stars) || 0))).filter(Boolean);
        const avg = stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : 0;
        const points = Math.round(avg * POINTS_PER_STAR);
        const encores = ctx.roundSubs('encore').filter((s) => s.player_id !== performerId).length;
        await ctx.award([
          { playerId: performerId, points, reason: REASON.talent },
          { playerId: performerId, points: encores * ENCORE_POINTS, reason: REASON.talentEncore },
        ]);
        const reveal: Reveal = { performerId, talent, avg, count: stars.length, points, encores };
        return ctx.setStep('reveal', { ...reveal });
      }
      default:
        return ctx.endRound();
    }
  },

  /** Skip = swap this performer's talent for a fresh one (the old one is retired by "never show again"). */
  async skip(ctx) {
    const st = ctx.run.state as RunState;
    const performerId = String(ctx.room.state.performerId ?? '');
    if (ctx.room.round === 1 && ctx.room.state.step === 'prep') return ctx.setStep('prep', {}, { seconds: PREP_SECONDS });
    await ctx.removeSubs(ctx.roundSubs().filter((s) => s.kind !== 'talent').map((s) => s.id));
    const spare = [...(st.spare ?? [])];
    const next = spare.shift();
    if (performerId && next) {
      const talents = { ...(st.talents ?? {}), [performerId]: next.text };
      const talentIds = { ...(st.talentIds ?? {}) };
      if (next.id) talentIds[performerId] = next.id;
      else delete talentIds[performerId];
      markUsed('talents', [next.id]);
      await ctx.saveRun({ talents, talentIds, spare });
      const row = ctx.roundSubs('talent').find((s) => s.player_id === performerId);
      if (row) await ctx.removeSubs([row.id]);
      await ctx.addSubs([{ kind: 'talent', player_id: performerId, payload: { talent: next.text } }]);
    }
    return announce(ctx);
  },

  ready(ctx) {
    if (ctx.room.state.step !== 'rate') return false;
    const performerId = ctx.room.state.performerId;
    const voters = ctx.players.filter((p) => p.connected && p.id !== performerId);
    const rated = new Set(ctx.roundSubs('rating').map((s) => s.player_id));
    return voters.length > 0 && voters.every((p) => rated.has(p.id));
  },

  TV: TalentTV,
  Phone: TalentPhone,
};

function Stars({ value }: { value: number }) {
  return (
    <span className="stars" aria-label={`${value.toFixed(1)} stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={value >= i - 0.25 ? 'star on' : value >= i - 0.75 ? 'star half' : 'star'}>★</span>
      ))}
    </span>
  );
}

function TalentTV({ room, players, subs }: TVGameProps) {
  const step = room.state.step;
  const map = new Map(players.map((p) => [p.id, p]));
  const performer = map.get(String(room.state.performerId ?? ''));
  const talent = String(room.state.talent ?? '');
  const done = (room.state.done ?? []).length;
  const liveEncores = subs.filter((s) => s.round === room.round && s.kind === 'encore' && s.player_id !== room.state.performerId).length;

  if (step === 'prep') {
    return (
      <div className="center-stack">
        <h1 className="display">Check your phone</h1>
        <p className="lead">Everyone just received a talent they cannot do.</p>
        <p className="lead dim">You have 2 minutes to prepare. Do not tell anyone. Commit.</p>
      </div>
    );
  }

  if (!performer) return null;

  if (step === 'announce') {
    return (
      <div className="center-stack talent-stage">
        <p className="lead dim">Next up on stage</p>
        <div className="pop-in"><PlayerChip player={performer} size="xl" /></div>
        <p className="lead">and their incredible talent:</p>
        <h1 className="display talent-text pop-in">{talent}</h1>
      </div>
    );
  }

  if (step === 'perform') {
    return (
      <div className="center-stack talent-stage">
        <PlayerChip player={performer} size="xl" />
        <h1 className="display talent-text">{talent}</h1>
        <p className="lead dim">🎤 Performing live…</p>
      </div>
    );
  }

  if (step === 'rate') {
    return (
      <div className="center-stack talent-stage">
        <PlayerChip player={performer} size="xl" />
        <h1 className="display">Rate the performance!</h1>
        <p className="lead dim">{done} of {Math.max(players.length - 1, 0)} rated</p>
        {liveEncores > 0 && <p className="lead pop-in">👏 {liveEncores} encore{liveEncores === 1 ? '' : 's'}!</p>}
      </div>
    );
  }

  const avg = Number(room.state.avg ?? 0);
  const count = Number(room.state.count ?? 0);
  return (
    <div className="center-stack talent-stage">
      <PlayerChip player={performer} size="xl" />
      <div className="stars-big pop-in"><Stars value={avg} /></div>
      <p className="big-num">{count ? avg.toFixed(1) : '—'}</p>
      <p className="lead dim">{count} rating{count === 1 ? '' : 's'}</p>
      {Number(room.state.encores ?? 0) > 0 && <p className="lead">👏 {Number(room.state.encores)} encore{Number(room.state.encores) === 1 ? '' : 's'} (+{Number(room.state.encores) * ENCORE_POINTS})</p>}
      <p className="points big-num">+{Number(room.state.points ?? 0) + Number(room.state.encores ?? 0) * ENCORE_POINTS}</p>
    </div>
  );
}

function TalentPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const performer = players.find((p) => p.id === room.state.performerId);
  const you = performer?.id === me.id;
  const myTalent = String(api.mySubs.find((s) => s.kind === 'talent')?.payload.talent ?? '');
  const mine = api.mySubs.find((s) => s.kind === 'rating');
  const encored = api.mySubs.some((s) => s.kind === 'encore');
  const [err, setErr] = useState<string | null>(null);

  if (step === 'prep') {
    return (
      <div className="phone-center center-stack">
        <p className="dim">Your secret talent</p>
        <h1 className="display talent-phone">{myTalent || 'Loading…'}</h1>
        <p className="lead">You cannot do this. You will do it anyway.</p>
        <p className="dim">Prepare. Do not spoil it for anyone.</p>
      </div>
    );
  }

  if (step === 'announce' || step === 'perform') {
    return (
      <div className="phone-center center-stack">
        {you ? (
          <>
            <h1 className="display">{step === 'announce' ? "You're up!" : '🎤 GO!'}</h1>
            <p className="lead">{String(room.state.talent ?? myTalent)}</p>
            <p className="dim">Go to the front of the room and commit.</p>
          </>
        ) : (
          <>
            <h2>Watch {performer?.name ?? 'the performer'}</h2>
            {performer && <PlayerChip player={performer} size="xl" />}
            <p className="dim">Ratings open after the act.</p>
          </>
        )}
      </div>
    );
  }

  if (step === 'rate') {
    if (you) {
      return (
        <div className="phone-center center-stack">
          <h2>Take a bow</h2>
          <p className="dim">The audience is rating you…</p>
        </div>
      );
    }
    return (
      <div className="phone-center center-stack">
        <h2>Rate {performer?.name}</h2>
        <div className="star-buttons">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`star-btn${Number(mine?.payload.stars) >= n ? ' on' : ''}`}
              onClick={() => {
                setErr(null);
                api.submit('rating', { stars: n }).catch((e) => setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late!' : errorCode(e)));
              }}
              aria-label={`${n} stars`}
            >
              ★
            </button>
          ))}
        </div>
        <p className="dim">{mine ? `You gave ${String(mine.payload.stars)}. Tap to change.` : 'Tap a star'}</p>
        <button
          className={`btn btn-lg${encored ? ' btn-primary' : ''}`}
          disabled={encored}
          onClick={() => {
            api.submit('encore', {}).catch((e) => setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late!' : errorCode(e)));
          }}
        >
          👏 {encored ? 'Encore sent!' : 'Encore!'}
        </button>
        {err && <p className="error">{err}</p>}
      </div>
    );
  }

  const avg = Number(room.state.avg ?? 0);
  return (
    <div className="phone-center center-stack">
      <h2>{performer?.name}</h2>
      <Stars value={avg} />
      <p className="big-num">{Number(room.state.count) ? avg.toFixed(1) : '—'}</p>
      {you && <p className="points big-num">+{Number(room.state.points ?? 0) + Number(room.state.encores ?? 0) * ENCORE_POINTS}</p>}
    </div>
  );
}
