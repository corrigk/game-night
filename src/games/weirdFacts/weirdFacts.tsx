import { useState, type ReactNode } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { draw, shuffle } from '../../lib/random';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { errorCode } from '../../lib/supabase';
import { tooClose } from '../../lib/textMatch';
import type { Player } from '../../lib/types';
import { REASON, WF_FOOLED_POINTS, WF_TRUTH_POINTS } from '../reasons';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';

/**
 * Weird Facts (bluffing). Write: everyone invents a fake answer. Vote: fakes plus
 * the truth, shuffled. Reveal: count through the picks, credit authors, show the truth.
 *
 * The real answer lives only in game_runs.state (host-only RLS) until the reveal.
 * During voting it is stored as an ordinary 'real' submission with no author, so
 * nothing a phone can read distinguishes it from the fakes.
 */

interface Fact {
  id?: string;
  prompt: string;
  answer: string;
  aliases: string[];
  blurb: string;
  kind: 'short' | 'phrase';
}

interface Item {
  id: string;
  text: string;
  real: boolean;
  authorId: string | null;
  pickers: string[];
}

interface Rejection {
  reason: 'real' | 'dup' | 'bad';
  n: number;
}

const WRITE_SECONDS = { short: 60, phrase: 90 };
const VOTE_SECONDS = 45;
const MAX_LEN = { short: 30, phrase: 80 };

const FALLBACK: Fact[] = [
  { prompt: 'Sea otters hold ____ while they sleep so they do not drift apart.', answer: 'hands', aliases: ['hand'], blurb: 'Groups of floating otters are called rafts.', kind: 'short' },
  { prompt: 'A group of ferrets is called a ____.', answer: 'business', aliases: [], blurb: 'Yes, a business of ferrets.', kind: 'short' },
];

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

function currentFact(ctx: GameCtx): Fact {
  return (ctx.run.state as { current?: Fact }).current ?? FALLBACK[0];
}

async function startVote(ctx: GameCtx) {
  const fact = currentFact(ctx);
  const fakes = ctx.roundSubs('fake').filter((s) => clean(s.payload.text));
  const [real] = await ctx.addSubs([{ kind: 'real', player_id: null, payload: { text: fact.answer } }]);
  await ctx.saveRun({ realId: real.id });
  const options = shuffle([
    ...fakes.map((s) => ({ id: s.id, text: clean(s.payload.text) })),
    { id: real.id, text: fact.answer },
  ]);
  if (options.length < 2) return startReveal(ctx);
  await ctx.setStep('vote', { prompt: fact.prompt, kind: fact.kind, options }, { seconds: VOTE_SECONDS, vote: ['pick'] });
}

async function startReveal(ctx: GameCtx) {
  const realId = (ctx.run.state as { realId?: string }).realId;
  const votes = ctx.roundVotes('pick');
  const ids = new Set(ctx.players.map((p) => p.id));
  const items: Item[] = [];
  for (const s of [...ctx.roundSubs('fake'), ...ctx.roundSubs('real')]) {
    const text = clean(s.payload.text);
    if (!text) continue;
    items.push({
      id: s.id,
      text,
      real: s.kind === 'real' && s.id === realId,
      authorId: s.player_id && ids.has(s.player_id) ? s.player_id : null,
      pickers: votes.filter((v) => v.target_submission_id === s.id).map((v) => v.voter_id),
    });
  }
  // Fakes least-picked first, the truth last.
  items.sort((a, b) => Number(a.real) - Number(b.real) || a.pickers.length - b.pickers.length);
  await showReveal(ctx, items, 0);
}

async function showReveal(ctx: GameCtx, items: Item[], idx: number) {
  const fact = currentFact(ctx);
  const last = idx >= items.length - 1;
  if (last) await awardRound(ctx, items);
  await ctx.setStep(
    'reveal',
    { prompt: fact.prompt, blurb: fact.blurb, items, idx, last },
    last ? {} : { seconds: 6 },
  );
}

async function awardRound(ctx: GameCtx, items: Item[]) {
  // Keep the night's best lie for the recap.
  const bestFake = items.filter((i) => !i.real).sort((a, b) => b.pickers.length - a.pickers.length)[0];
  if (bestFake?.pickers.length) {
    const history = [...(((ctx.run.state as { history?: unknown[] }).history) ?? [])];
    history.push({ prompt: currentFact(ctx).prompt, text: bestFake.text, authorId: bestFake.authorId, fooled: bestFake.pickers.length });
    await ctx.saveRun({ history });
  }
  const events: { playerId: string; points: number; reason: string }[] = [];
  for (const it of items) {
    if (it.real) {
      for (const voter of it.pickers) events.push({ playerId: voter, points: WF_TRUTH_POINTS, reason: REASON.wfTruth });
    } else if (it.authorId && it.pickers.length) {
      events.push({ playerId: it.authorId, points: WF_FOOLED_POINTS * it.pickers.length, reason: REASON.wfFooled });
    }
  }
  await ctx.award(events);
}

export const weirdFacts: GameModule = {
  id: 'weird_facts',
  title: 'Weird Facts',
  emoji: '🧐',
  tagline: 'Fake the fact. Find the truth.',
  rules: [
    'A real fact appears with a blank. Write a fake answer that sounds true.',
    'Then vote for the answer you think is real. You cannot pick your own.',
    'Find the truth, and fool your friends, to score.',
  ],
  scored: true,
  defaultRounds: 6,
  maxRounds: 30,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & Record<string, unknown>>('facts');
    const facts: Fact[] = leastUsed(rows).map((r) => ({
      id: r.id,
      prompt: String(r.prompt),
      answer: String(r.answer),
      aliases: (r.aliases as string[] | null) ?? [],
      blurb: String(r.blurb ?? ''),
      kind: r.kind === 'phrase' ? 'phrase' : 'short',
    }));
    await ctx.saveRun({ deck: facts.length ? facts : FALLBACK, cursor: 0 });
  },

  async startRound(ctx) {
    const st = ctx.run.state as { deck?: Fact[]; cursor?: number };
    const { item, deck, cursor } = draw(st.deck?.length ? st.deck : FALLBACK, st.cursor ?? 0);
    markUsed('facts', [item.id]);
    await ctx.saveRun({ deck, cursor, current: item, realId: null, cur: item.id ? { table: 'facts', id: item.id } : null });
    await ctx.setStep(
      'write',
      { prompt: item.prompt, kind: item.kind, maxLen: MAX_LEN[item.kind], rejected: {} },
      { seconds: WRITE_SECONDS[item.kind], submit: ['fake'] },
    );
  },

  /** Reject fakes that match the truth (or an alias), or another player's fake. */
  async process(ctx) {
    if (ctx.room.state.step !== 'write') return;
    const fact = currentFact(ctx);
    const answers = [fact.answer, ...fact.aliases];
    const max = MAX_LEN[fact.kind];
    const subs = [...ctx.roundSubs('fake')].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const kept: string[] = [];
    const bad: { id: string; playerId: string; reason: Rejection['reason'] }[] = [];

    for (const s of subs) {
      const text = clean(s.payload.text);
      let reason: Rejection['reason'] | null = null;
      if (!text || text.length > max + 5) reason = 'bad';
      else if (answers.some((a) => tooClose(text, a))) reason = 'real';
      else if (kept.some((k) => tooClose(text, k))) reason = 'dup';
      if (reason) bad.push({ id: s.id, playerId: s.player_id!, reason });
      else kept.push(text);
    }
    if (!bad.length) return;

    const prev = (ctx.room.state.rejected ?? {}) as Record<string, Rejection>;
    const rejected = { ...prev };
    for (const b of bad) rejected[b.playerId] = { reason: b.reason, n: (prev[b.playerId]?.n ?? 0) + 1 };
    await ctx.removeSubs(bad.map((b) => b.id));
    await ctx.patchState({ rejected });
  },

  async next(ctx) {
    const state = ctx.room.state;
    if (state.step === 'write') return startVote(ctx);
    if (state.step === 'vote') return startReveal(ctx);
    if (state.step === 'reveal') {
      if (state.last) return ctx.endRound();
      return showReveal(ctx, state.items as Item[], Number(state.idx) + 1);
    }
  },

  ready(ctx) {
    const step = ctx.room.state.step;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (step === 'write') {
      const wrote = new Set(ctx.roundSubs('fake').map((s) => s.player_id));
      return active.every((p) => wrote.has(p.id));
    }
    if (step === 'vote') {
      const voted = new Set(ctx.roundVotes('pick').map((v) => v.voter_id));
      return active.every((p) => voted.has(p.id));
    }
    return false;
  },

  TV: WeirdFactsTV,
  Phone: WeirdFactsPhone,
};

function Blank({ text }: { text: string }): ReactNode {
  const parts = text.split(/_{2,}/);
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && <span className="wf-blank">&nbsp;</span>}
    </span>
  ));
}

function WeirdFactsTV({ room, players }: TVGameProps) {
  const map = new Map(players.map((p) => [p.id, p]));
  const prompt = String(room.state.prompt ?? '');
  const step = room.state.step;
  const done = (room.state.done ?? []).length;

  if (step === 'write') {
    return (
      <div className="center-stack wf-stage">
        <p className="wf-kicker">Write a fake answer on your phone</p>
        <h1 className="display wf-prompt"><Blank text={prompt} /></h1>
        <p className="lead dim">{done} of {players.length} wrote something</p>
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    return (
      <div className="center-stack wf-stage">
        <h2 className="wf-prompt-small"><Blank text={prompt} /></h2>
        <p className="wf-kicker">Which one is true? Vote on your phone</p>
        <div className="wf-options">
          {options.map((o, i) => (
            <div key={o.id} className="wf-option pop-in" style={{ animationDelay: `${i * 80}ms` }}>
              {o.text}
            </div>
          ))}
        </div>
        <p className="lead dim">{done} of {players.length} voted</p>
      </div>
    );
  }

  const items = (room.state.items as Item[]) ?? [];
  const idx = Number(room.state.idx ?? 0);
  const last = Boolean(room.state.last);
  const shown = items.slice(0, idx + 1);
  const blurb = String(room.state.blurb ?? '');

  return (
    <div className="center-stack wf-stage">
      <h2 className="wf-prompt-small"><Blank text={prompt} /></h2>
      <div className="wf-options">
        {shown.map((it, i) => {
          const author = it.authorId ? map.get(it.authorId) : null;
          const pickers = it.pickers.map((id) => map.get(id)).filter((p): p is Player => Boolean(p));
          const current = i === idx;
          return (
            <div key={it.id} className={`wf-reveal${it.real ? ' wf-real' : ''}${current ? ' wf-current pop-in' : ''}`}>
              <div className="wf-reveal-text">
                {it.real && <span className="wf-truth">THE TRUTH</span>} {it.text}
              </div>
              {!it.real && (
                <div className="wf-reveal-meta">
                  {author ? <>written by <PlayerChip player={author} size="sm" /></> : <span className="dim">nobody</span>}
                </div>
              )}
              <div className="wf-pickers">
                {pickers.length === 0 ? (
                  <span className="dim">{it.real ? 'Nobody found it!' : 'Fooled nobody'}</span>
                ) : (
                  <>
                    <span className="dim">{it.real ? 'found it:' : `fooled ${pickers.length}:`}</span>
                    {pickers.map((p) => <PlayerChip key={p.id} player={p} size="sm" />)}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {last && blurb && <p className="lead wf-blurb pop-in">{blurb}</p>}
    </div>
  );
}

function WeirdFactsPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const prompt = String(room.state.prompt ?? '');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  if (step === 'write') {
    const max = Number(room.state.maxLen ?? 30);
    const mine = api.mySubs.find((s) => s.kind === 'fake');
    const rejection = (room.state.rejected as Record<string, Rejection> | undefined)?.[me.id];
    const send = async () => {
      setBusy(true);
      setErr(null);
      try {
        await api.submit('fake', { text: text.trim() });
      } catch (e) {
        setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late!' : errorCode(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="stack gap">
        <h2 className="wf-prompt-phone"><Blank text={prompt} /></h2>
        {mine ? (
          <div className="card center-stack">
            <p className="dim">Your fake answer</p>
            <h2>{String(mine.payload.text)}</h2>
            <p className="dim">Locked in. Edit it below any time before time runs out.</p>
          </div>
        ) : (
          rejection && (
            <p className="error center">
              {rejection.reason === 'real'
                ? 'Too close to the real answer! Try something else.'
                : rejection.reason === 'dup'
                  ? 'Somebody already wrote something almost identical. Be more original!'
                  : 'That one did not work. Try again.'}
            </p>
          )
        )}
        <form
          className="stack gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send();
          }}
        >
          <input
            className="input input-lg"
            value={text}
            maxLength={max}
            onChange={(e) => setText(e.target.value)}
            placeholder={mine ? 'Change your answer…' : 'Your fake answer'}
            autoComplete="off"
            autoCapitalize="none"
          />
          <div className="row gap">
            <span className="dim small grow">{text.length}/{max}</span>
            <button className="btn btn-primary btn-lg" disabled={busy || !text.trim()}>
              {mine ? 'Update' : 'Submit'}
            </button>
          </div>
        </form>
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    const mineId = api.mySubs.find((s) => s.kind === 'fake')?.id;
    const picked = pending ?? api.myVotes.find((v) => v.kind === 'pick')?.target_submission_id ?? null;
    return (
      <div className="stack gap">
        <h2 className="wf-prompt-phone"><Blank text={prompt} /></h2>
        <p className="center dim">Which one is the real answer?</p>
        {options.map((o) => {
          const own = o.id === mineId;
          return (
            <button
              key={o.id}
              className={`wf-pick${picked === o.id ? ' selected' : ''}`}
              disabled={own}
              onClick={() => {
                setErr(null);
                setPending(o.id);
                api
                  .vote('pick', { submissionId: o.id })
                  .catch((e) => setErr(errorCode(e) === 'OWN_SUBMISSION' ? "You can't pick your own." : errorCode(e)))
                  .finally(() => setPending(null));
              }}
            >
              {o.text}
              {own && <span className="dim small"> (yours)</span>}
            </button>
          );
        })}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  const items = (room.state.items as Item[]) ?? [];
  const last = Boolean(room.state.last);
  if (!last) {
    return (
      <div className="phone-center center-stack">
        <h2>Eyes on the TV!</h2>
        <p className="dim">The answers are being revealed…</p>
      </div>
    );
  }
  const real = items.find((it) => it.real);
  const myPick = items.find((it) => it.pickers.includes(me.id));
  const mine = items.find((it) => it.authorId === me.id);
  const fooled = mine?.pickers.length ?? 0;
  const foundTruth = Boolean(myPick?.real);
  const fell = myPick && !myPick.real ? players.find((p) => p.id === myPick.authorId) : null;
  return (
    <div className="phone-center center-stack">
      <p className="dim">The truth</p>
      <h2>{real?.text}</h2>
      {foundTruth ? <p className="points big-num">+{WF_TRUTH_POINTS}</p> : <p className="dim">{fell ? `You fell for ${fell.name}'s lie.` : 'You did not vote.'}</p>}
      {fooled > 0 && <p className="points">You fooled {fooled}: +{fooled * WF_FOOLED_POINTS}</p>}
    </div>
  );
}
