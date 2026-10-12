import { useEffect, useState } from 'react';
import { useNow } from '../../components/Countdown';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { serverNow } from '../../lib/clock';
import { draw, shuffle } from '../../lib/random';
import { errorCode } from '../../lib/supabase';
import { REASON } from '../reasons';
import { AnonOptions, RevealList, tallyAnonymous, topIds, VoteList, type AnonItem } from '../shared/anon';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';
import { PLOT_TWIST_CONFIG as C } from './config';

/**
 * Plot Twist. A short story setup appears (typewriter style on the TV). Everyone writes the twist
 * ending, then everyone votes anonymously (not for their own) and authors are unmasked.
 */

interface Setup {
  id?: string;
  setup: string;
  genre?: string | null;
}

const FALLBACK: Setup[] = [
  { setup: 'Father Tom was halfway through his homily when the church lights flickered and went out. A hush fell over the parish. Then, from the back pew, something began to hum.', genre: 'Mystery' },
  { setup: 'Every morning at 7:15, the neighborhood dog walked himself to the bakery. Today, he came home with two bags instead of one. And a note.', genre: 'Cozy Mystery' },
  { setup: 'The astronaut had trained for ten years for this one moment. She stepped onto the surface of Mars and planted the flag. Behind her, a tiny voice said, "You are late."', genre: 'Sci-Fi' },
  { setup: 'Grandpa insisted he could fix the leaky faucet himself. Three hours later, the whole family heard him call out from the basement, "Nobody panic."', genre: 'Comedy' },
];

const textOf = (p: Record<string, unknown>) => String(p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, C.maxTwistLength + 20);

async function startVote(ctx: GameCtx) {
  const subs = ctx.roundSubs('twist').filter((s) => textOf(s.payload));
  if (!subs.length) return ctx.endRound();
  if (subs.length === 1) return reveal(ctx);
  const options = shuffle(subs.map((s) => ({ id: s.id, text: textOf(s.payload) })));
  const { setup, genre } = ctx.room.state;
  await ctx.setStep('vote', { setup, genre, options }, { seconds: C.voteSeconds, vote: ['twv'] });
}

async function reveal(ctx: GameCtx) {
  const items = tallyAnonymous(ctx, 'twist', 'twv', textOf);
  const winners = topIds(items);
  await ctx.award(
    items.flatMap((it) =>
      it.authorId
        ? [
            { playerId: it.authorId, points: it.votes * C.pointsPerVote, reason: REASON.twistVotes },
            { playerId: it.authorId, points: winners.includes(it.id) ? C.winnerBonus : 0, reason: REASON.twistWin },
          ]
        : [],
    ),
  );
  const { setup, genre } = ctx.room.state;
  await ctx.setStep('reveal', { setup, genre, items, winners });
}

export const plotTwist: GameModule = {
  id: 'plot_twist',
  title: 'Plot Twist',
  emoji: '🌀',
  tagline: 'Everyone gets the setup. Nobody saw it coming.',
  rules: [
    'A short story setup appears.',
    'Write the twist ending, in under 160 characters.',
    'Vote for the best twist (not your own). Votes and a winner bonus score.',
  ],
  scored: true,
  defaultRounds: C.defaultRounds,
  maxRounds: C.maxRounds,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & Setup>('plot_twist_setups');
    const deck: Setup[] = rows.length
      ? leastUsed(rows).map((r) => ({ id: r.id, setup: String(r.setup), genre: (r.genre as string | null) ?? null }))
      : shuffle(FALLBACK);
    await ctx.saveRun({ deck, cursor: 0 });
  },

  async startRound(ctx) {
    const st = ctx.run.state as { deck?: Setup[]; cursor?: number };
    const d = draw(st.deck?.length ? st.deck : FALLBACK, st.cursor ?? 0);
    markUsed('plot_twist_setups', [d.item.id]);
    await ctx.saveRun({ deck: d.deck, cursor: d.cursor, cur: d.item.id ? { table: 'plot_twist_setups', id: d.item.id } : null });
    await ctx.setStep('write', { setup: d.item.setup, genre: d.item.genre ?? null }, { seconds: C.writeSeconds, submit: ['twist'] });
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'write') return startVote(ctx);
    if (step === 'vote') return reveal(ctx);
    return ctx.endRound();
  },

  ready(ctx) {
    const step = ctx.room.state.step;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (step === 'write') {
      const sent = new Set(ctx.roundSubs('twist').map((s) => s.player_id));
      return active.every((p) => sent.has(p.id));
    }
    if (step === 'vote') {
      const voted = new Set(ctx.roundVotes('twv').map((v) => v.voter_id));
      return active.every((p) => voted.has(p.id));
    }
    return false;
  },

  TV: PlotTwistTV,
  Phone: PlotTwistPhone,
};

// ---------------------------------------------------------------- TV
/** Types the setup out. Based on the step's start time, so a refresh doesn't replay it. */
function Typewriter({ text, since }: { text: string; since: number }) {
  useNow(60);
  const shown = Math.min(text.length, Math.max(0, Math.floor(((serverNow() - since) / 1000) * C.typewriterCharsPerSecond)));
  return (
    <p className="twist-setup">
      {text.slice(0, shown)}
      {shown < text.length && <span className="twist-caret">▌</span>}
    </p>
  );
}

function Genre({ genre }: { genre?: unknown }) {
  return genre ? <div className="pill pill-generic twist-genre">{String(genre)}</div> : null;
}

function PlotTwistTV({ room, players }: TVGameProps) {
  const step = room.state.step;
  const setup = String(room.state.setup ?? '');
  const done = (room.state.done ?? []).length;

  if (step === 'write') {
    return (
      <div className="center-stack twist-stage">
        <Genre genre={room.state.genre} />
        <Typewriter text={setup} since={Number(room.state.stepAt ?? Date.now())} />
        <p className="lead">Write the twist ending on your phone.</p>
        <p className="lead dim">{done} of {players.length} wrote one</p>
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    return (
      <div className="center-stack twist-stage">
        <p className="twist-setup twist-setup-small">{setup}</p>
        <p className="lead dim">Which twist is best? ({done} of {players.length} voted)</p>
        <AnonOptions options={options} />
      </div>
    );
  }

  const items = (room.state.items as AnonItem[]) ?? [];
  const winners = (room.state.winners as string[]) ?? [];
  return (
    <div className="center-stack twist-stage">
      <p className="twist-setup twist-setup-small">{setup}</p>
      <RevealList
        items={items}
        winners={winners}
        players={players}
        label="Best twist"
        pointsFor={(it, win) => it.votes * C.pointsPerVote + (win ? C.winnerBonus : 0)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- phone
function PlotTwistPhone({ room, me, api }: PhoneGameProps) {
  const step = room.state.step;
  const setup = String(room.state.setup ?? '');
  const mine = api.mySubs.find((s) => s.kind === 'twist');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(''), [setup]);

  if (step === 'write') {
    const send = async () => {
      setBusy(true);
      setErr(null);
      try {
        await api.submit('twist', { text: text.trim() });
      } catch (e) {
        setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Time is up!' : errorCode(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="stack gap">
        {room.state.genre ? <div className="story-genre-card">{String(room.state.genre)}</div> : null}
        <div className="card"><p className="twist-setup-phone">{setup}</p></div>
        <textarea
          className="input input-lg"
          rows={4}
          value={text}
          maxLength={C.maxTwistLength}
          onChange={(e) => setText(e.target.value)}
          placeholder="…and then the twist!"
        />
        <div className="row gap">
          <span className="dim small grow">{text.length}/{C.maxTwistLength}</span>
          <button className="btn btn-primary btn-lg" disabled={busy || !text.trim()} onClick={() => void send()}>
            {mine ? 'Update' : 'Submit'}
          </button>
        </div>
        {mine && <p className="center dim">Sent: “{String(mine.payload.text)}”. You can still change it.</p>}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    return (
      <div className="stack gap">
        <div className="card"><p className="twist-setup-phone">{setup}</p></div>
        <p className="center dim">Which twist is best?</p>
        <VoteList options={options} mineId={mine?.id} kind="twv" api={api} />
      </div>
    );
  }

  const items = (room.state.items as AnonItem[]) ?? [];
  const winners = (room.state.winners as string[]) ?? [];
  const myItem = items.find((i) => i.authorId === me.id);
  const pts = myItem ? myItem.votes * C.pointsPerVote + (winners.includes(myItem.id) ? C.winnerBonus : 0) : 0;
  return (
    <div className="phone-center center-stack">
      <p className="dim">Best twist</p>
      <h2>{items.find((i) => winners.includes(i.id))?.text ?? 'No votes'}</h2>
      {myItem ? <p className="points big-num">+{pts}</p> : <p className="dim">You did not submit this round.</p>}
    </div>
  );
}
