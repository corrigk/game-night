import { useState } from 'react';
import { Avatar, PlayerChip } from '../../components/PlayerChip';
import { errorCode } from '../../lib/supabase';
import type { Player, Submission } from '../../lib/types';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';

/**
 * Tap Race: a 30-second warm-up that exercises the whole engine (timers, input
 * gating, realtime submissions, scoring, results). Wait for green, then tap.
 */

const POINTS = [300, 200, 100];

interface Result {
  playerId: string;
  ms: number;
  points: number;
}

function tapOrder(subs: Submission[], goAt: number): Result[] {
  return [...subs]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((s, i) => ({
      playerId: s.player_id!,
      ms: Math.max(0, Date.parse(s.created_at) - goAt),
      points: POINTS[i] ?? 0,
    }));
}

async function go(ctx: GameCtx) {
  await ctx.setStep('go', {}, { seconds: 8, submit: ['tap'] });
}

async function reveal(ctx: GameCtx) {
  const goAt = Number(ctx.room.state.stepAt ?? 0);
  const results = tapOrder(ctx.roundSubs('tap'), goAt);
  await ctx.award(results.map((r, i) => ({ playerId: r.playerId, points: r.points, reason: `Tap Race: #${i + 1}` })));
  await ctx.setStep('reveal', { results });
}

export const tapRace: GameModule = {
  id: 'tap_race',
  title: 'Tap Race',
  emoji: '⚡',
  tagline: 'Warm-up: wait for green, then tap.',
  rules: ['Your phone turns green at a random moment.', 'Tap as fast as you can.', 'Fastest three score.'],
  scored: true,
  defaultRounds: 3,
  maxRounds: 10,
  status: 'ready',

  async startRound(ctx) {
    // Random hidden delay so nobody can anticipate the green.
    await ctx.setStep('wait', { hideTimer: true }, { seconds: 2 + Math.random() * 3 });
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'wait') await go(ctx);
    else if (step === 'go') await reveal(ctx);
    else await ctx.endRound();
  },

  async onTimerEnd(ctx) {
    const step = ctx.room.state.step;
    if (step === 'wait') await go(ctx);
    else if (step === 'go') await reveal(ctx);
  },

  ready(ctx) {
    if (ctx.room.state.step !== 'go') return false;
    const active = ctx.players.filter((p) => p.connected);
    const tapped = new Set(ctx.roundSubs('tap').map((s) => s.player_id));
    return active.length > 0 && active.every((p) => tapped.has(p.id));
  },

  TV: TapRaceTV,
  Phone: TapRacePhone,
};

function byId(players: Player[]) {
  return new Map(players.map((p) => [p.id, p]));
}

function TapRaceTV({ room, players, subs }: TVGameProps) {
  const step = room.state.step;
  const map = byId(players);

  if (step === 'wait') {
    return (
      <div className="tap-stage tap-wait">
        <h1 className="display huge">Get ready…</h1>
        <p className="lead">Wait for green</p>
      </div>
    );
  }

  if (step === 'go') {
    const goAt = Number(room.state.stepAt ?? 0);
    const order = tapOrder(subs.filter((s) => s.round === room.round && s.kind === 'tap'), goAt);
    return (
      <div className="tap-stage tap-go">
        <h1 className="display huge">TAP!</h1>
        <div className="row wrap gap center">
          {order.map((r) => {
            const p = map.get(r.playerId);
            return p ? <PlayerChip key={r.playerId} player={p} size="lg" /> : null;
          })}
        </div>
      </div>
    );
  }

  const results = (room.state.results as Result[] | undefined) ?? [];
  return (
    <div className="center-stack">
      <h1 className="display">Reaction times</h1>
      {results.length === 0 && <p className="lead">Nobody tapped. Bold strategy.</p>}
      <ol className="tap-results">
        {results.map((r, i) => {
          const p = map.get(r.playerId);
          if (!p) return null;
          return (
            <li key={r.playerId} className={i < 3 ? 'pop-in' : undefined} style={{ animationDelay: `${i * 120}ms` }}>
              <span className="tap-place">{i + 1}</span>
              <PlayerChip player={p} size="lg" />
              <span className="tap-ms">{(r.ms / 1000).toFixed(3)}s</span>
              {r.points > 0 && <span className="points">+{r.points}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TapRacePhone({ room, me, api }: PhoneGameProps) {
  const [err, setErr] = useState<string | null>(null);
  const step = room.state.step;
  const tapped = api.mySubs.some((s) => s.kind === 'tap');

  if (step === 'wait') {
    return (
      <div className="phone-center">
        <button className="tap-button tap-button-wait" disabled>
          Wait…
        </button>
      </div>
    );
  }

  if (step === 'go') {
    return (
      <div className="phone-center">
        {tapped ? (
          <div className="center-stack">
            <Avatar player={me} size="xl" />
            <h2>Tapped!</h2>
          </div>
        ) : (
          <button
            className="tap-button tap-button-go"
            onPointerDown={() => {
              api.submit('tap', {}).catch((e) => setErr(errorCode(e)));
            }}
          >
            TAP!
          </button>
        )}
        {err && <p className="error">{err === 'NOT_ACCEPTING' ? 'Too late!' : err}</p>}
      </div>
    );
  }

  const results = (room.state.results as Result[] | undefined) ?? [];
  const idx = results.findIndex((r) => r.playerId === me.id);
  return (
    <div className="phone-center center-stack">
      {idx >= 0 ? (
        <>
          <h1 className="display">#{idx + 1}</h1>
          <p className="lead">{(results[idx].ms / 1000).toFixed(3)}s</p>
          {results[idx].points > 0 && <p className="points">+{results[idx].points}</p>}
        </>
      ) : (
        <h2>No tap this round</h2>
      )}
    </div>
  );
}
