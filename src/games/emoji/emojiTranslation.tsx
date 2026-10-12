import { useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { emojiOnly } from '../../lib/emoji';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { load, save } from '../../lib/storage';
import { shuffle } from '../../lib/random';
import { errorCode } from '../../lib/supabase';
import { REASON } from '../reasons';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';
import { EMOJI_CONFIG as C, EMOJI_PALETTE } from './config';

/**
 * Emoji Translation (individual). Everyone is secretly assigned a title and builds a clue from
 * emoji only. Then one clue at a time is shown on the TV and everyone else picks the title from 5
 * choices (the real one plus 4 decoys from the same category).
 *
 * Secrecy: a player's title reaches only their own phone, as a private 'secret' row. The multiple
 * choice options are public but unlabeled; which one is right lives only in game_runs.state.
 */

interface Title {
  id?: string;
  title: string;
  category: string;
}
interface RunState {
  all?: Title[];
  assigned?: Record<string, Title>;
  queue?: string[];
  cursor?: number;
  current?: { composerId: string; correctIndex: number; answer: string };
}
interface Reveal {
  clue: string;
  answer: string;
  category: string;
  composerId: string;
  correct: { playerId: string; points: number }[];
  wrong: string[];
  guesserCount: number;
  composerPoints: number;
}

const FALLBACK: Title[] = [
  { title: 'Jaws', category: 'movies' }, { title: 'Titanic', category: 'movies' }, { title: 'Frozen', category: 'movies' },
  { title: 'Shrek', category: 'movies' }, { title: 'Up', category: 'movies' }, { title: 'Toy Story', category: 'movies' },
];

const CATEGORY_LABEL: Record<string, string> = {
  movies: 'Movie', bible: 'Bible story', saints: 'Saint', songs: 'Song', foods: 'Food', tv: 'TV show',
};
export const categoryLabel = (c: string) => CATEGORY_LABEL[c.toLowerCase()] ?? c;

const clueOf = (payload: Record<string, unknown>) => emojiOnly(String(payload.emojis ?? ''), C.maxEmoji);

async function showClue(ctx: GameCtx) {
  const st = ctx.run.state as RunState;
  const here = new Set(ctx.players.map((p) => p.id));
  const clues = new Map<string, string[]>();
  for (const s of ctx.allSubs('clue')) {
    if (!s.player_id || !here.has(s.player_id)) continue;
    const e = clueOf(s.payload);
    if (e.length) clues.set(s.player_id, e);
  }
  if (!clues.size) return ctx.setStep('none', {});

  // Rotate through composers; everyone is shown once before anyone repeats.
  let queue = (st.queue ?? []).filter((id) => clues.has(id));
  let cursor = st.cursor ?? 0;
  if (!queue.length || cursor >= queue.length) {
    queue = shuffle([...clues.keys()]);
    cursor = 0;
  }
  const composerId = queue[cursor];
  const title = st.assigned?.[composerId] ?? FALLBACK[0];

  const sameCategory = (st.all ?? []).filter((t) => t.category === title.category && t.title.toLowerCase() !== title.title.toLowerCase());
  const others = (st.all ?? []).filter((t) => t.category !== title.category);
  const decoys = shuffle(sameCategory).slice(0, C.decoys);
  if (decoys.length < C.decoys) decoys.push(...shuffle(others).slice(0, C.decoys - decoys.length));
  const choices = shuffle([title, ...decoys]);
  const correctIndex = choices.findIndex((t) => t === title);

  await ctx.saveRun({
    queue,
    cursor: cursor + 1,
    current: { composerId, correctIndex, answer: title.title },
    cur: title.id ? { table: 'emoji_titles', id: title.id } : null,
  });
  await ctx.setStep(
    'guess',
    {
      composerId,
      clue: clues.get(composerId)!.join(''),
      category: title.category,
      options: choices.map((t, i) => ({ i, text: t.title })),
    },
    { seconds: C.guessSeconds, submit: ['guess'] },
  );
}

async function reveal(ctx: GameCtx) {
  const cur = (ctx.run.state as RunState).current;
  if (!cur) return ctx.endRound();
  const { composerId, correctIndex, answer } = cur;
  const startedAt = Number(ctx.room.state.stepAt ?? 0);
  const windowMs = C.guessSeconds * 1000;
  const guessers = ctx.players.filter((p) => p.id !== composerId);
  const entries = ctx
    .roundSubs('guess')
    .filter((s) => s.player_id && s.player_id !== composerId)
    .map((s) => ({
      playerId: s.player_id!,
      right: Number(s.payload.i) === correctIndex,
      elapsed: Math.min(windowMs, Math.max(0, Date.parse(s.created_at) - startedAt)),
    }));
  const correct = entries
    .filter((e) => e.right)
    .map((e) => ({ playerId: e.playerId, points: C.basePoints + Math.round(C.speedBonusMax * (1 - e.elapsed / windowMs)) }));
  const everyone = guessers.length > 0 && correct.length >= guessers.length;
  // Reward clever, not obvious (everyone) or impossible (nobody).
  const composerPoints = correct.length === 0 || everyone ? 0 : correct.length * C.composerPointsPerCorrect;

  await ctx.award([
    ...correct.map((c) => ({ playerId: c.playerId, points: c.points, reason: REASON.emojiGuess })),
    { playerId: composerId, points: composerPoints, reason: REASON.emojiComposer },
  ]);
  const data: Reveal = {
    clue: String(ctx.room.state.clue ?? ''),
    answer,
    category: String(ctx.room.state.category ?? ''),
    composerId,
    correct,
    wrong: entries.filter((e) => !e.right).map((e) => e.playerId),
    guesserCount: guessers.length,
    composerPoints,
  };
  await ctx.setStep('reveal', { ...data });
}

export const emojiTranslation: GameModule = {
  id: 'emoji_translation',
  title: 'Emoji Translation',
  emoji: '🔤',
  tagline: 'Say it with emoji. No words allowed.',
  rules: [
    'You secretly get a title (a movie, Bible story, saint, song, food or show).',
    'Build a clue using ONLY emoji, up to 8.',
    'Then guess everyone else\'s clues from 5 choices. Fast and right scores more.',
    'Clue makers score when SOME people get it. Too obvious or too hard earns nothing.',
  ],
  scored: true,
  defaultRounds: C.defaultRounds,
  maxRounds: C.maxRounds,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & Title>('emoji_titles');
    const all: Title[] = rows.length ? rows.map((r) => ({ id: r.id, title: String(r.title), category: String(r.category) })) : FALLBACK;
    const deck: Title[] = rows.length ? leastUsed(rows).map((r) => ({ id: r.id, title: String(r.title), category: String(r.category) })) : shuffle(FALLBACK);
    const assigned: Record<string, Title> = {};
    ctx.players.forEach((p, i) => {
      assigned[p.id] = deck[i % deck.length];
    });
    markUsed('emoji_titles', Object.values(assigned).map((t) => t.id));
    await ctx.saveRun({ all, assigned, queue: null, cursor: 0 });
  },

  async startRound(ctx) {
    if (ctx.room.round > 1) return showClue(ctx);
    const assigned = (ctx.run.state as RunState).assigned ?? {};
    await ctx.addSubs(
      ctx.players
        .filter((p) => assigned[p.id])
        .map((p) => ({ kind: 'secret', player_id: p.id, payload: { title: assigned[p.id].title, category: assigned[p.id].category } })),
    );
    await ctx.setStep('compose', {}, { seconds: C.composeSeconds, submit: ['clue'] });
  },

  /** Clues are emoji only: anything else is stripped on send, and an empty one is bounced. */
  async process(ctx) {
    if (ctx.room.state.step !== 'compose') return;
    const bad = ctx.roundSubs('clue').filter((s) => clueOf(s.payload).length === 0);
    if (!bad.length) return;
    const prev = (ctx.room.state.rejected ?? {}) as Record<string, number>;
    const rejected = { ...prev };
    for (const b of bad) if (b.player_id) rejected[b.player_id] = (prev[b.player_id] ?? 0) + 1;
    await ctx.removeSubs(bad.map((b) => b.id));
    await ctx.patchState({ rejected });
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'compose') return showClue(ctx);
    if (step === 'guess') return reveal(ctx);
    if (step === 'none') return ctx.endGame();
    return ctx.endRound();
  },

  /** Skip: during composing, start the clues now; during a clue, drop it for the next composer. */
  async skip(ctx) {
    const step = ctx.room.state.step;
    if (step === 'none') return ctx.endGame();
    if (step === 'guess' || step === 'reveal') await ctx.removeSubs(ctx.roundSubs('guess').map((s) => s.id));
    return showClue(ctx);
  },

  ready(ctx) {
    const step = ctx.room.state.step;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (step === 'compose') {
      const assigned = (ctx.run.state as RunState).assigned ?? {};
      const sent = new Set(ctx.roundSubs('clue').map((s) => s.player_id));
      const need = active.filter((p) => assigned[p.id]);
      return need.length > 0 && need.every((p) => sent.has(p.id));
    }
    if (step === 'guess') {
      const composerId = ctx.room.state.composerId;
      const guessed = new Set(ctx.roundSubs('guess').map((s) => s.player_id));
      const need = active.filter((p) => p.id !== composerId);
      return need.length > 0 && need.every((p) => guessed.has(p.id));
    }
    return false;
  },

  TV: EmojiTV,
  Phone: EmojiPhone,
};

// ---------------------------------------------------------------- TV
function EmojiTV({ room, players }: TVGameProps) {
  const step = room.state.step;
  const map = new Map(players.map((p) => [p.id, p]));
  const done = (room.state.done ?? []).length;

  if (step === 'compose') {
    return (
      <div className="center-stack">
        <h1 className="display">Build your clue!</h1>
        <p className="lead">Check your phone for your secret title. Use only emoji.</p>
        <div className="emoji-clue emoji-clue-small">🎬 📖 🎵 🍕 ⛪ 📺</div>
        <p className="lead dim">{done} of {players.length} sent a clue</p>
      </div>
    );
  }

  if (step === 'none') {
    return (
      <div className="center-stack">
        <h1 className="display">No clues came in</h1>
        <p className="lead">Nobody sent an emoji clue. Press Space to head back.</p>
      </div>
    );
  }

  const composer = map.get(String(room.state.composerId ?? ''));
  if (step === 'guess') {
    return (
      <div className="center-stack emoji-stage">
        <div className="pill pill-generic emoji-cat">{categoryLabel(String(room.state.category ?? ''))}</div>
        <div className="emoji-clue">{String(room.state.clue ?? '')}</div>
        <p className="lead dim">
          {done} of {Math.max(players.length - 1, 0)} guessed · {composer ? 'composed by a mystery artist' : ''}
        </p>
      </div>
    );
  }

  const r = room.state as unknown as Reveal;
  const winners = r.correct.map((c) => ({ p: map.get(c.playerId), points: c.points })).filter((x) => x.p);
  return (
    <div className="center-stack emoji-stage">
      <div className="emoji-clue emoji-clue-mid">{r.clue}</div>
      <h1 className="display pop-in">{r.answer}</h1>
      <div className="row gap center wrap">
        <span className="lead dim">made by</span>
        {composer && <PlayerChip player={composer} size="lg" />}
        <span className="points">{r.composerPoints > 0 ? `+${r.composerPoints}` : '+0'}</span>
      </div>
      <p className="lead">
        {r.correct.length} of {r.guesserCount} got it
        {r.composerPoints === 0 && r.correct.length === r.guesserCount && r.guesserCount > 0 ? ' · too obvious!' : ''}
        {r.composerPoints === 0 && r.correct.length === 0 ? ' · nobody got it!' : ''}
      </p>
      <div className="row gap center wrap">
        {winners.map(({ p, points }) => (
          <span key={p!.id} className="emoji-winner pop-in">
            <PlayerChip player={p!} size="md" /> <span className="points">+{points}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- phone
function EmojiPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  if (step === 'compose') return <Compose room={room} me={me} api={api} />;

  if (step === 'none') return <div className="phone-center"><h2>No clues came in.</h2></div>;

  const composerId = String(room.state.composerId ?? '');
  const composer = players.find((p) => p.id === composerId);

  if (step === 'guess') {
    if (composerId === me.id) {
      return (
        <div className="phone-center center-stack">
          <div className="emoji-clue emoji-clue-small">{String(room.state.clue ?? '')}</div>
          <h2>That's your clue!</h2>
          <p className="dim">Everyone is guessing. Keep a straight face.</p>
        </div>
      );
    }
    const options = (room.state.options as { i: number; text: string }[]) ?? [];
    const chosen = pending ?? (api.mySubs.find((s) => s.kind === 'guess')?.payload.i as number | undefined) ?? null;
    return (
      <div className="stack gap">
        <div className="emoji-clue emoji-clue-small">{String(room.state.clue ?? '')}</div>
        <p className="center dim">{categoryLabel(String(room.state.category ?? ''))}: which one is it?</p>
        {options.map((o) => (
          <button
            key={o.i}
            className={`wf-pick${chosen === o.i ? ' selected' : ''}`}
            onClick={() => {
              setErr(null);
              setPending(o.i);
              api.submit('guess', { i: o.i }).catch((e) => setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late!' : errorCode(e))).finally(() => setPending(null));
            }}
          >
            {o.text}
          </button>
        ))}
        {chosen != null && <p className="center dim">Locked in. Tap another to change it.</p>}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  const r = room.state as unknown as Reveal;
  const won = r.correct.find((c) => c.playerId === me.id);
  const wasWrong = r.wrong.includes(me.id);
  return (
    <div className="phone-center center-stack">
      <div className="emoji-clue emoji-clue-small">{r.clue}</div>
      <h2>{r.answer}</h2>
      {composerId === me.id ? (
        r.composerPoints > 0 ? <p className="points big-num">+{r.composerPoints}</p> : <p className="dim">Too obvious or too tricky: no points this time.</p>
      ) : won ? (
        <p className="points big-num">+{won.points}</p>
      ) : (
        <p className="dim">{wasWrong ? 'Not this time.' : 'You did not answer.'}</p>
      )}
      {composer && composerId !== me.id && <p className="dim">by {composer.name}</p>}
    </div>
  );
}

function Compose({ room, me, api }: Pick<PhoneGameProps, 'room' | 'me' | 'api'>) {
  const secret = api.mySubs.find((s) => s.kind === 'secret')?.payload as { title?: string; category?: string } | undefined;
  const mine = api.mySubs.find((s) => s.kind === 'clue');
  const key = `partypack:emoji:${room.current_run_id}`;
  const [emojis, setEmojis] = useState<string[]>(() => load<string[]>(key, []));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rejected = Number((room.state.rejected as Record<string, number> | undefined)?.[me.id] ?? 0);

  const set = (next: string[]) => {
    const clean = next.slice(0, C.maxEmoji);
    setEmojis(clean);
    save(key, clean);
  };

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.submit('clue', { emojis: emojis.join('') });
    } catch (e) {
      setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Time is up!' : errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  if (!secret) {
    return (
      <div className="phone-center center-stack">
        <h2>Sit this round out</h2>
        <p className="dim">You joined after the game started. You can still guess everyone else's clues.</p>
      </div>
    );
  }

  return (
    <div className="stack gap">
      <div className="card center-stack">
        <p className="dim small">Your secret {categoryLabel(String(secret.category ?? ''))}</p>
        <h2>{secret.title}</h2>
      </div>
      <div className="emoji-compose">
        <div className="emoji-clue emoji-clue-small">{emojis.length ? emojis.join('') : <span className="dim">Build your clue…</span>}</div>
        <div className="dim small center">{emojis.length}/{C.maxEmoji} emoji · text is not allowed</div>
      </div>
      <input
        className="input"
        value=""
        placeholder="Tap here to use your emoji keyboard"
        onChange={(e) => set([...emojis, ...emojiOnly(e.target.value, C.maxEmoji)])}
        autoComplete="off"
      />
      <div className="emoji-palette">
        {EMOJI_PALETTE.map((e, i) => (
          <button key={`${e}${i}`} className="emoji-key" onClick={() => set([...emojis, e])} disabled={emojis.length >= C.maxEmoji} aria-label={`Add ${e}`}>
            {e}
          </button>
        ))}
      </div>
      <div className="row gap">
        <button className="btn grow" onClick={() => set(emojis.slice(0, -1))} disabled={!emojis.length}>⌫ Undo</button>
        <button className="btn grow" onClick={() => set([])} disabled={!emojis.length}>Clear</button>
      </div>
      <button className="btn btn-primary btn-lg sticky-bottom" disabled={busy || !emojis.length} onClick={() => void send()}>
        {mine ? 'Update clue' : 'Send clue'}
      </button>
      {mine && <p className="center dim">Sent! You can still change it until time runs out.</p>}
      {!mine && rejected > 0 && <p className="error center">A clue needs at least one emoji.</p>}
      {err && <p className="error center">{err}</p>}
    </div>
  );
}
