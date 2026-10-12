import { useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { shuffle } from '../../lib/random';
import { errorCode } from '../../lib/supabase';
import { tooClose } from '../../lib/textMatch';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';
import { MOVIE_CONFIG as C } from './config';

/**
 * Movie Voting (no points). Everyone suggests 1-2 movies. Everyone gets two votes. The top three
 * move forward to a runoff, and so on, until one movie wins. It's a way to choose tonight's movie.
 *
 * Votes: a voter's two votes use the kinds 'v1' and 'v2' (different movies). Candidates are host-
 * written 'cand' rows so duplicate suggestions merge into one entry.
 */

interface Cand {
  id: string;
  title: string;
  by: string[];
}
interface Item {
  id: string;
  title: string;
  votes: number;
  by: string[];
  advancing: boolean;
}
interface RunState {
  finalists?: { title: string; by: string[] }[];
}

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, C.maxTitleLength);

/** Merge suggestions that are really the same movie ("Lion King" and "The Lion King"). */
function mergeSuggestions(entries: { title: string; by: string }[]): { title: string; by: string[] }[] {
  const out: { title: string; by: string[] }[] = [];
  for (const e of entries) {
    const hit = out.find((o) => tooClose(o.title, e.title));
    if (hit) {
      if (!hit.by.includes(e.by)) hit.by.push(e.by);
    } else {
      out.push({ title: e.title, by: [e.by] });
    }
  }
  return out;
}

async function startVote(ctx: GameCtx, cands: { title: string; by: string[] }[]) {
  if (!cands.length) return ctx.setStep('none', {});
  const rows = await ctx.addSubs(cands.map((c) => ({ kind: 'cand', player_id: null, payload: { title: c.title, by: c.by } })));
  const options = shuffle(rows.map((r) => ({ id: r.id, title: String(r.payload.title) })));
  const final = ctx.room.round >= ctx.room.rounds_total;
  if (options.length === 1) return reveal(ctx);
  await ctx.setStep('vote', { options, final }, { seconds: C.voteSeconds, vote: ['v1', 'v2'] });
}

async function reveal(ctx: GameCtx) {
  const round = ctx.room.round;
  const cands: Cand[] = ctx.roundSubs('cand').map((s) => ({ id: s.id, title: String(s.payload.title), by: (s.payload.by as string[]) ?? [] }));
  const votes = ctx.roundVotes().filter((v) => v.kind === 'v1' || v.kind === 'v2');
  const items: Item[] = cands
    .map((c) => ({ id: c.id, title: c.title, by: c.by, votes: votes.filter((v) => v.target_submission_id === c.id).length, advancing: false }))
    .sort((a, b) => b.votes - a.votes);

  const final = round >= ctx.room.rounds_total || items.length <= 1;
  const keep = round === 1 ? C.advanceAfterFirst : C.advanceAfterLater;
  const cutoff = items[Math.min(keep, items.length) - 1]?.votes ?? 0; // ties at the cutoff all move on
  for (const it of items) it.advancing = final ? it.votes === items[0].votes : it.votes >= cutoff;

  await ctx.saveRun({ finalists: items.filter((i) => i.advancing).map((i) => ({ title: i.title, by: i.by })) });
  await ctx.setStep('reveal', { items, final });
}

export const movieVoting: GameModule = {
  id: 'movie_vote',
  title: 'Movie Voting',
  emoji: '🎬',
  tagline: 'Pick tonight\'s movie. Two votes each, then a runoff.',
  rules: [
    'Everyone suggests one or two movies.',
    'Everyone gets two votes, on two different movies.',
    'The top three move on to a runoff. Last one standing wins.',
  ],
  scored: false,
  defaultRounds: C.defaultRounds,
  maxRounds: C.maxRounds,
  status: 'ready',

  async startRound(ctx) {
    if (ctx.room.round === 1) {
      return ctx.setStep('submit', { maxLen: C.maxTitleLength }, { seconds: C.submitSeconds, submit: ['movie'] });
    }
    const finalists = (ctx.run.state as RunState).finalists ?? [];
    return startVote(ctx, finalists);
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'submit') {
      const entries: { title: string; by: string }[] = [];
      for (const s of ctx.roundSubs('movie')) {
        const titles = ((s.payload.titles as unknown[] | undefined) ?? []).map(clean).filter(Boolean).slice(0, C.maxSuggestions);
        for (const title of titles) if (s.player_id) entries.push({ title, by: s.player_id });
      }
      return startVote(ctx, mergeSuggestions(entries));
    }
    if (step === 'vote') return reveal(ctx);
    if (step === 'none') return ctx.endGame();
    // reveal
    if (ctx.room.state.final) return ctx.endGame();
    return ctx.endRound();
  },

  ready(ctx) {
    const step = ctx.room.state.step;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (step === 'submit') {
      const sent = new Set(ctx.roundSubs('movie').map((s) => s.player_id));
      return active.every((p) => sent.has(p.id));
    }
    if (step === 'vote') {
      const voted = new Set(ctx.roundVotes('v1').map((v) => v.voter_id));
      return active.every((p) => voted.has(p.id));
    }
    return false;
  },

  TV: MovieTV,
  Phone: MoviePhone,
};

// ---------------------------------------------------------------- TV
function MovieTV({ room, players }: TVGameProps) {
  const step = room.state.step;
  const map = new Map(players.map((p) => [p.id, p]));
  const done = (room.state.done ?? []).length;

  if (step === 'submit') {
    return (
      <div className="center-stack">
        <h1 className="display">🎬 What should we watch?</h1>
        <p className="lead">Suggest one or two movies on your phone.</p>
        <p className="lead dim">{done} of {players.length} sent suggestions</p>
      </div>
    );
  }

  if (step === 'none') {
    return (
      <div className="center-stack">
        <h1 className="display">No suggestions</h1>
        <p className="lead">Nobody suggested a movie. Press Space to head back.</p>
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; title: string }[]) ?? [];
    return (
      <div className="center-stack movie-stage">
        <h1 className="display">{room.state.final ? 'Final vote!' : `Vote! Round ${room.round}`}</h1>
        <p className="lead dim">Pick {C.votesPerPlayer} different movies · {done} of {players.length} voted</p>
        <div className={`movie-grid${options.length > 8 ? ' movie-grid-dense' : ''}`}>
          {options.map((o, i) => (
            <div key={o.id} className="movie-tile pop-in" style={{ animationDelay: `${i * 40}ms` }}>
              {o.title}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const items = (room.state.items as Item[]) ?? [];
  const final = Boolean(room.state.final);
  const max = Math.max(1, items[0]?.votes ?? 1);
  const winners = items.filter((i) => i.advancing);

  if (final) {
    return (
      <div className="center-stack movie-stage">
        <div className="intro-emoji pop-in">🏆</div>
        <p className="lead dim">{winners.length > 1 ? 'It\'s a tie! Tonight\'s movies:' : 'Tonight\'s movie is…'}</p>
        {winners.map((w) => (
          <div key={w.id} className="pop-in">
            <h1 className="display huge title-glow">{w.title}</h1>
            <p className="lead">
              {w.votes} vote{w.votes === 1 ? '' : 's'} · suggested by{' '}
              {w.by.map((id) => map.get(id)).filter(Boolean).map((p) => p!.name).join(' & ') || 'someone'}
            </p>
          </div>
        ))}
        <p className="tv-footer"><kbd>Space</kbd> to finish</p>
      </div>
    );
  }

  return (
    <div className="center-stack movie-stage">
      <h1 className="display">Results</h1>
      <ol className="movie-bars">
        {items.map((it, i) => (
          <li key={it.id} className={`pop-in${it.advancing ? ' movie-adv' : ' movie-out'}`} style={{ animationDelay: `${i * 90}ms` }}>
            <span className="movie-title">{it.title}</span>
            <span className="mlt-bar"><i style={{ width: `${(it.votes / max) * 100}%`, background: it.advancing ? 'var(--success)' : 'var(--text-dim)' }} /></span>
            <span className="mlt-count">{it.votes}</span>
            <span className="movie-by">
              {it.by.slice(0, 3).map((id) => map.get(id)).filter(Boolean).map((p) => <PlayerChip key={p!.id} player={p!} size="sm" hideName />)}
            </span>
          </li>
        ))}
      </ol>
      <p className="lead">{winners.length} move{winners.length === 1 ? 's' : ''} on to the runoff · <kbd>Space</kbd></p>
    </div>
  );
}

// ---------------------------------------------------------------- phone
function MoviePhone({ room, me, api }: PhoneGameProps) {
  const step = room.state.step;
  if (step === 'submit') return <Suggest room={room} api={api} />;
  if (step === 'none') return <div className="phone-center"><h2>No suggestions came in.</h2></div>;
  if (step === 'vote') return <Vote room={room} api={api} />;

  const items = (room.state.items as Item[]) ?? [];
  const final = Boolean(room.state.final);
  const winners = items.filter((i) => i.advancing);
  const mine = items.filter((i) => i.by.includes(me.id));
  return (
    <div className="phone-center center-stack">
      <h2>{final ? 'The winner' : 'Moving on'}</h2>
      {winners.map((w) => (
        <p key={w.id} className="lead"><b>{w.title}</b> <span className="dim">({w.votes})</span></p>
      ))}
      {mine.length > 0 && <p className="dim">Your pick{mine.length > 1 ? 's' : ''}: {mine.map((m) => `${m.title} (${m.votes})`).join(', ')}</p>}
    </div>
  );
}

function Suggest({ room, api }: Pick<PhoneGameProps, 'room' | 'api'>) {
  const mine = api.mySubs.find((s) => s.kind === 'movie');
  const sent = ((mine?.payload.titles as string[] | undefined) ?? []).filter(Boolean);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = Number(room.state.maxLen ?? C.maxTitleLength);

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.submit('movie', { titles: [a, b].map((t) => t.trim()).filter(Boolean) });
    } catch (e) {
      setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late!' : errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap">
      <h2 className="center">🎬 Suggest a movie</h2>
      <p className="center dim">One or two. Anything you'd happily watch.</p>
      {sent.length > 0 && (
        <div className="card center-stack">
          <p className="dim small">Your suggestions</p>
          {sent.map((t) => <h3 key={t}>{t}</h3>)}
          <p className="dim small">Change them below any time before time is up.</p>
        </div>
      )}
      <input className="input input-lg" value={a} maxLength={max} onChange={(e) => setA(e.target.value)} placeholder="Movie #1" autoComplete="off" />
      <input className="input input-lg" value={b} maxLength={max} onChange={(e) => setB(e.target.value)} placeholder="Movie #2 (optional)" autoComplete="off" />
      <button className="btn btn-primary btn-lg" disabled={busy || !a.trim()} onClick={() => void send()}>
        {sent.length ? 'Update suggestions' : 'Send'}
      </button>
      {err && <p className="error center">{err}</p>}
    </div>
  );
}

function Vote({ room, api }: Pick<PhoneGameProps, 'room' | 'api'>) {
  const options = (room.state.options as { id: string; title: string }[]) ?? [];
  const need = Math.min(C.votesPerPlayer, options.length);
  const locked = ['v1', 'v2']
    .map((k) => api.myVotes.find((v) => v.kind === k)?.target_submission_id)
    .filter((x): x is string => Boolean(x));
  const [sel, setSel] = useState<string[]>(locked);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const same = sel.length === locked.length && sel.every((s) => locked.includes(s));

  const toggle = (id: string) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= need ? [...s.slice(1), id] : [...s, id]));

  const lockIn = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.vote('v1', { submissionId: sel[0] });
      if (sel[1]) await api.vote('v2', { submissionId: sel[1] });
    } catch (e) {
      setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Voting just closed.' : errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap">
      <h2 className="center">{room.state.final ? 'Final vote!' : 'Vote!'}</h2>
      <p className="center dim">Pick {need} different movie{need === 1 ? '' : 's'} ({sel.length}/{need})</p>
      {options.map((o) => (
        <button key={o.id} className={`wf-pick${sel.includes(o.id) ? ' selected' : ''}`} onClick={() => toggle(o.id)}>
          {sel.includes(o.id) ? `✓ ${sel.indexOf(o.id) + 1}. ` : ''}
          {o.title}
        </button>
      ))}
      <button className="btn btn-primary btn-lg sticky-bottom" disabled={busy || sel.length !== need || same} onClick={() => void lockIn()}>
        {locked.length && same ? '✓ Votes locked in' : 'Lock in my votes'}
      </button>
      {err && <p className="error center">{err}</p>}
    </div>
  );
}
