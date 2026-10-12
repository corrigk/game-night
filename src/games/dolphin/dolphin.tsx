import { useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { useNow } from '../../components/Countdown';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { secondsLeft, serverNow } from '../../lib/clock';
import { draw, shuffle } from '../../lib/random';
import { errorCode, supabase } from '../../lib/supabase';
import { REASON } from '../reasons';
import type { GameCtx, GameModule, HostControlsProps, PhoneGameProps, TVGameProps } from '../types';
import { DOLPHIN_CONFIG as C } from './config';

/**
 * Dolphin. One player is the Dolphin and steps out of the room. Everyone else is secretly told a
 * physical task. The Dolphin comes back and tries to work out what to do from yes/no feedback
 * alone (spoken, the app collects nothing). Host presses Enter when it's done.
 *
 * Secrecy: the task is never in public state. Each non-Dolphin player gets a private 'task' row
 * only they can read; the TV shows the task only at the reveal.
 */

interface Task {
  id?: string;
  text: string;
}
interface RunState {
  deck?: Task[];
  cursor?: number;
  gone?: string[];
  current?: { dolphinId: string; task: string; taskId?: string };
}

const FALLBACK: Task[] = [
  { text: 'Put a sock on a lamp' },
  { text: 'Put a shoe on top of the TV remote' },
  { text: 'Carry a pillow to the kitchen and set it on the counter' },
  { text: 'Hand the host a shoe, then bow' },
  { text: 'Stand on one foot next to the tallest person in the room' },
  { text: 'Pick up a cup, hold it up to the TV, and say "cheers" to it' },
];

const state = (ctx: GameCtx) => ctx.run.state as RunState;

async function nextTask(ctx: GameCtx): Promise<Task> {
  const st = state(ctx);
  const d = draw(st.deck?.length ? st.deck : FALLBACK, st.cursor ?? 0);
  markUsed('dolphin_tasks', [d.item.id]);
  await ctx.saveRun({ deck: d.deck, cursor: d.cursor, cur: d.item.id ? { table: 'dolphin_tasks', id: d.item.id } : null });
  return d.item;
}

async function writeTaskRows(ctx: GameCtx, dolphinId: string, task: string) {
  const old = ctx.roundSubs('task').map((s) => s.id);
  if (old.length) await ctx.removeSubs(old);
  const dolphin = ctx.players.find((p) => p.id === dolphinId);
  await ctx.addSubs(
    ctx.players.filter((p) => p.id !== dolphinId).map((p) => ({ kind: 'task', player_id: p.id, payload: { task, dolphin: dolphin?.name ?? 'the Dolphin' } })),
  );
}

/** Pick a Dolphin (random among players who haven't gone, unless forced) and set up the leave screen. */
async function startDolphin(ctx: GameCtx, opts: { exclude?: string; force?: string } = {}) {
  const here = ctx.players;
  let gone = (state(ctx).gone ?? []).filter((id) => here.some((p) => p.id === id));
  let pool = here.filter((p) => !gone.includes(p.id) && p.id !== opts.exclude);
  if (!pool.length) {
    gone = []; // everyone has gone: start a new cycle
    pool = here.filter((p) => p.id !== opts.exclude);
  }
  if (!pool.length) pool = here;
  const dolphin = (opts.force && here.find((p) => p.id === opts.force)) || shuffle(pool)[0];

  await ctx.removeSubs(ctx.roundSubs().map((s) => s.id));
  const task = await nextTask(ctx);
  await ctx.saveRun({ gone, current: { dolphinId: dolphin.id, task: task.text, taskId: task.id } });
  await writeTaskRows(ctx, dolphin.id, task.text); // before the step, so phones find it on first fetch
  await ctx.setStep('leave', { dolphinId: dolphin.id, hideStrip: true }, { submit: ['ready'], count: [] });
}

async function finish(ctx: GameCtx, solved: boolean) {
  const cur = state(ctx).current;
  if (!cur) return ctx.endRound();
  const room = ctx.room;
  const totalMs = C.playSeconds * 1000;
  const remaining = room.state.paused
    ? Number(room.state.pausedLeft ?? 0)
    : room.timer_ends_at
      ? Math.max(0, Date.parse(room.timer_ends_at) - serverNow())
      : 0;
  const frac = Math.min(1, remaining / totalMs);
  const dolphinPoints = solved ? C.dolphinMinPoints + Math.round((C.dolphinMaxPoints - C.dolphinMinPoints) * frac) : 0;
  const bonus = solved ? C.othersBonus : 0;

  await ctx.award([
    { playerId: cur.dolphinId, points: dolphinPoints, reason: REASON.dolphinSolved },
    ...ctx.players.filter((p) => p.id !== cur.dolphinId).map((p) => ({ playerId: p.id, points: bonus, reason: REASON.dolphinBonus })),
  ]);
  const gone = [...new Set([...(state(ctx).gone ?? []), cur.dolphinId])];
  await ctx.saveRun({ gone });
  await ctx.setStep('reveal', {
    dolphinId: cur.dolphinId,
    task: cur.task,
    solved,
    dolphinPoints,
    bonus,
    secondsUsed: Math.round((totalMs - remaining) / 1000),
  });
}

export const dolphin: GameModule = {
  id: 'dolphin',
  title: 'Dolphin',
  emoji: '🐬',
  tagline: 'One player leaves. The group knows the task. Yes or no only.',
  rules: [
    'One player is the Dolphin and steps out of the room.',
    'Everyone else is secretly told a simple physical task for the Dolphin to do.',
    'The Dolphin returns. You may only answer yes or no out loud, nothing else.',
    'Solve it before the timer ends: faster is more points for the Dolphin.',
  ],
  scored: true,
  defaultRounds: C.defaultRounds,
  defaultRoundsFor: (players) => Math.max(1, Math.min(C.defaultRoundsCap, players)),
  maxRounds: C.maxRounds,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & Task>('dolphin_tasks');
    const deck: Task[] = rows.length ? leastUsed(rows).map((r) => ({ id: r.id, text: String(r.text) })) : shuffle(FALLBACK);
    await ctx.saveRun({ deck, cursor: 0, gone: [] });
  },

  startRound: (ctx) => startDolphin(ctx),

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'leave') {
      return ctx.setStep('play', { dolphinId: ctx.room.state.dolphinId, hideStrip: true }, { seconds: C.playSeconds });
    }
    if (step === 'play') return; // only Enter / Solved or the timer ends it, so Space can't end a round by accident
    return ctx.endRound();
  },

  async onTimerEnd(ctx) {
    if (ctx.room.state.step === 'play') return finish(ctx, false);
  },

  /** Skip: choose a different Dolphin (the skipped player has not gone yet). */
  async skip(ctx) {
    const step = ctx.room.state.step;
    if (step === 'reveal') return ctx.endRound();
    return startDolphin(ctx, { exclude: state(ctx).current?.dolphinId });
  },

  async action(ctx, name, payload) {
    const step = ctx.room.state.step;
    const cur = state(ctx).current;
    if ((name === 'enter' || name === 'solved') && step === 'play') return finish(ctx, true);
    if (name === 'rerollTask' && cur && (step === 'leave' || step === 'play')) {
      if (payload.retire && cur.taskId) await supabase.from('dolphin_tasks').update({ vetoed: true }).eq('id', cur.taskId);
      const task = await nextTask(ctx);
      await ctx.saveRun({ current: { ...cur, task: task.text, taskId: task.id } });
      await writeTaskRows(ctx, cur.dolphinId, task.text);
      return ctx.patchState({ taskVersion: Date.now() }); // nudge phones to refetch
    }
    if (name === 'pickDolphin' && (step === 'leave' || step === 'play')) {
      const force = payload.playerId ? String(payload.playerId) : undefined;
      return startDolphin(ctx, force ? { force } : { exclude: cur?.dolphinId });
    }
  },

  HostControls: DolphinControls,
  TV: DolphinTV,
  Phone: DolphinPhone,
};

// ---------------------------------------------------------------- host drawer
function DolphinControls({ room, players, run, engine }: HostControlsProps) {
  const st = (run?.state ?? {}) as RunState;
  const gone = new Set(st.gone ?? []);
  const [pick, setPick] = useState('');
  const step = room.state.step;
  return (
    <div className="stack gap">
      <div className="drawer-grid">
        <button className="btn btn-primary" disabled={step !== 'play'} onClick={() => void engine.gameAction('solved')}>
          ✓ Solved <kbd>Enter</kbd>
        </button>
        <button className="btn" disabled={step !== 'leave' && step !== 'play'} onClick={() => void engine.gameAction('rerollTask')}>
          🎲 Re-roll task
        </button>
        <button className="btn" disabled={step !== 'leave' && step !== 'play'} onClick={() => void engine.gameAction('rerollTask', { retire: true })}>
          Retire task &amp; re-roll
        </button>
        <button className="btn" disabled={step !== 'leave' && step !== 'play'} onClick={() => void engine.gameAction('pickDolphin')}>
          🐬 New random Dolphin
        </button>
      </div>
      <div className="row gap">
        <select className="team-select grow" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose the Dolphin…</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {gone.has(p.id) ? ' (has gone)' : ''}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" disabled={!pick || (step !== 'leave' && step !== 'play')} onClick={() => void engine.gameAction('pickDolphin', { playerId: pick })}>
          Pick
        </button>
      </div>
      <p className="dim small">Space starts the timer once the Dolphin is back. Enter (or Solved) ends it.</p>
    </div>
  );
}

// ---------------------------------------------------------------- TV
function BigTimer({ room }: { room: TVGameProps['room'] }) {
  useNow(200);
  const left = room.state.paused ? Number(room.state.pausedLeft ?? 0) / 1000 : secondsLeft(room.timer_ends_at) ?? 0;
  const whole = Math.ceil(left);
  return <div className={`dolphin-timer${whole <= 10 ? ' dolphin-timer-urgent' : ''}`}>{whole}</div>;
}

function DolphinTV({ room, players, subs }: TVGameProps) {
  const step = room.state.step;
  const dolphinP = players.find((p) => p.id === room.state.dolphinId);
  if (!dolphinP) return <div className="center-stack"><div className="spinner" /></div>;

  if (step === 'leave') {
    const out = subs.some((s) => s.round === room.round && s.kind === 'ready');
    return (
      <div className="center-stack dolphin-stage">
        <div className="dolphin-emoji">🐬</div>
        <h1 className="display">{dolphinP.name} is the Dolphin!</h1>
        <PlayerChip player={dolphinP} size="xl" />
        <p className="lead">Please step out of the room.</p>
        <p className={out ? 'lead points' : 'lead dim'}>{out ? '✓ Out of the room' : 'Waiting for the Dolphin to tap "I\'m out"…'}</p>
        <p className="tv-footer">The task is secret. <kbd>Space</kbd> brings {dolphinP.name} back and starts the timer.</p>
      </div>
    );
  }

  if (step === 'play') {
    return (
      <div className="center-stack dolphin-stage">
        <div className="dolphin-emoji dolphin-bob">🐬</div>
        <BigTimer room={room} />
        <PlayerChip player={dolphinP} size="xl" />
        <p className="lead">Yes or no only! Press <kbd>Enter</kbd> when {dolphinP.name} gets it.</p>
      </div>
    );
  }

  const solved = Boolean(room.state.solved);
  return (
    <div className="center-stack dolphin-stage">
      <div className="dolphin-emoji pop-in">{solved ? '🐬🎉' : '🐬💤'}</div>
      <h1 className="display">{solved ? 'Solved!' : "Time's up!"}</h1>
      <PlayerChip player={dolphinP} size="xl" />
      <p className="lead">The task was:</p>
      <h2 className="dolphin-task pop-in">{String(room.state.task ?? '')}</h2>
      {solved ? (
        <p className="lead">
          <span className="points">+{Number(room.state.dolphinPoints)}</span> for {dolphinP.name} ·{' '}
          <span className="points">+{Number(room.state.bonus)}</span> for everyone else
        </p>
      ) : (
        <p className="lead dim">No points this time.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- phone
function DolphinPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const [err, setErr] = useState<string | null>(null);
  const dolphinP = players.find((p) => p.id === room.state.dolphinId);
  const isDolphin = room.state.dolphinId === me.id;
  const task = api.mySubs.find((s) => s.kind === 'task')?.payload.task as string | undefined;
  const ready = api.mySubs.some((s) => s.kind === 'ready');

  if (step === 'leave') {
    if (isDolphin) {
      return (
        <div className="phone-center center-stack">
          <div className="dolphin-emoji-phone">🐬</div>
          <h1 className="display phone-title">You're the Dolphin!</h1>
          <p className="lead">Leave the room. Tap when you're out.</p>
          <button
            className="btn btn-primary btn-lg"
            disabled={ready}
            onClick={() => api.submit('ready', {}).catch((e) => setErr(errorCode(e)))}
          >
            {ready ? '✓ Waiting for the host…' : "I'm out of the room"}
          </button>
          {err && <p className="error">{err}</p>}
        </div>
      );
    }
    return <TaskCard name={dolphinP?.name} task={task} />;
  }

  if (step === 'play') {
    if (isDolphin) {
      return (
        <div className="phone-center center-stack">
          <div className="dolphin-emoji-phone dolphin-bob">🐬</div>
          <h1 className="display phone-title">Figure it out!</h1>
          <p className="lead">The group can only say yes or no. Move around and try things.</p>
        </div>
      );
    }
    return <TaskCard name={dolphinP?.name} task={task} playing />;
  }

  const solved = Boolean(room.state.solved);
  return (
    <div className="phone-center center-stack">
      <h1 className="display phone-title">{solved ? 'Solved! 🎉' : "Time's up!"}</h1>
      <p className="dim">The task was</p>
      <h2>{String(room.state.task ?? '')}</h2>
      {isDolphin && solved && <p className="points big-num">+{Number(room.state.dolphinPoints)}</p>}
      {!isDolphin && solved && <p className="points">+{Number(room.state.bonus)}</p>}
    </div>
  );
}

function TaskCard({ name, task, playing = false }: { name?: string; task?: string; playing?: boolean }) {
  return (
    <div className="phone-center center-stack">
      <p className="dim">Secret task for {name ?? 'the Dolphin'}</p>
      <div className="card dolphin-secret">
        <h2>{task ?? 'Loading…'}</h2>
      </div>
      <p className="lead">{playing ? 'Answer yes or no only. Do not give hints!' : 'Do not tell anyone. Wait for the Dolphin to come back.'}</p>
    </div>
  );
}
