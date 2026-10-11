import { useEffect, useRef, useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { secondsLeft } from '../../lib/clock';
import { load, save } from '../../lib/storage';
import { shuffle } from '../../lib/random';
import { errorCode, supabase } from '../../lib/supabase';
import type { Player } from '../../lib/types';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';

/**
 * Story Chain (no scoring). Every player starts a story from a random genre + opening
 * line. Each round, stories rotate one seat and the writer sees ONLY the last line plus
 * the genre. Authors stay hidden until the finale, where each starter reads their story
 * aloud while the TV reveals it line by line, then reveals who wrote what.
 *
 * Private data: the full stories live in game_runs.state (host-only). Each writer's
 * prompt (genre + last line) is a 'prompt' submission only that player can read.
 */

const WRITE_SECONDS = 75;
const READ_SECONDS = 6;
const MAX_LINE = 160;

interface Line {
  t: string;
  by: string | null;
}
interface Story {
  genre: string;
  opening: string;
  lines: Line[];
}
interface RunState {
  order?: string[];
  stories?: Record<string, Story>;
}

const FALLBACK_SEEDS = [
  { genre: 'Space Opera', opening_line: 'The galaxy was out of snacks, and the captain was furious.' },
  { genre: 'Cozy Mystery', opening_line: 'The pie was missing, and so was Grandma.' },
  { genre: 'Western', opening_line: 'The sheriff had been waiting for noon for three days.' },
  { genre: 'Fairy Tale', opening_line: 'Once upon a time, a goat was elected mayor.' },
];

const PLACEHOLDERS = [
  'And then, suddenly, nothing happened for a very long time.',
  'Meanwhile, a goose watched silently from the window.',
  'It was at this moment that everyone remembered they left the oven on.',
  'Nobody could explain what happened next, least of all the narrator.',
  'The author fell asleep here, so please enjoy this moment of silence.',
  'Then a mysterious stranger arrived, ate everything, and left.',
  'At that exact second, the Wi-Fi went out.',
  'Plot twist: it was all a dream, and also a Tuesday.',
];

const fixedLine = (v: unknown, fallback: string) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
  return s || fallback;
};

const holderOf = (order: string[], storyIdx: number, round: number) => order[(storyIdx + round - 1) % order.length];

async function writeStep(ctx: GameCtx) {
  const st = ctx.run.state as RunState;
  const order = st.order ?? [];
  const stories = st.stories ?? {};
  const round = ctx.room.round;
  const here = new Set(ctx.players.map((p) => p.id));
  const final = round === ctx.room.rounds_total;

  const rows = order
    .map((starter, s) => ({ starter, holder: holderOf(order, s, round) }))
    .filter((x) => here.has(x.holder))
    .map(({ starter, holder }) => {
      const story = stories[starter];
      const last = story.lines.length ? story.lines[story.lines.length - 1].t : story.opening;
      return { kind: 'prompt', player_id: holder, payload: { storyId: starter, genre: story.genre, lastLine: last, final } };
    });
  await ctx.addSubs(rows); // before the step so phones see their prompt immediately
  await ctx.setStep('write', { final }, { seconds: WRITE_SECONDS, submit: ['line'] });
}

/** Collect this round's lines into the stories, filling gaps with placeholders. */
async function collect(ctx: GameCtx) {
  const st = ctx.run.state as RunState;
  const order = st.order ?? [];
  const stories: Record<string, Story> = JSON.parse(JSON.stringify(st.stories ?? {}));
  const round = ctx.room.round;
  const subs = ctx.roundSubs('line');
  order.forEach((starter, s) => {
    const holder = holderOf(order, s, round);
    const sub = subs.find((x) => x.player_id === holder);
    const raw = (sub?.payload.lines as unknown[] | undefined) ?? [];
    const pick = () => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
    stories[starter].lines.push(
      { t: fixedLine(raw[0], pick()), by: holder },
      { t: fixedLine(raw[1], pick()), by: holder },
    );
  });
  await ctx.saveRun({ stories });
  return { stories, order };
}

async function showStory(ctx: GameCtx, idx: number, shown: number) {
  const st = ctx.run.state as RunState;
  const starter = st.order![idx];
  const story = st.stories![starter];
  const texts = [story.opening, ...story.lines.map((l) => l.t)];
  const more = shown < texts.length;
  await ctx.setStep(
    more ? 'read' : 'authors',
    {
      idx, starter, genre: story.genre, texts, shown: Math.min(shown, texts.length),
      authors: more ? undefined : [null, ...story.lines.map((l) => l.by)],
      total: st.order!.length,
    },
    more ? { seconds: READ_SECONDS } : {},
  );
}

export const storyChain: GameModule = {
  id: 'story_chain',
  title: 'Story Chain',
  emoji: '📜',
  tagline: 'Write blind. Read aloud. No points, just chaos.',
  rules: [
    'Everyone starts a story with a genre and an opening line.',
    'Each round you get someone else\'s story, but you only see the LAST line. Add two lines.',
    'At the end, each person reads aloud the story they started. Authors are revealed.',
  ],
  scored: false,
  defaultRounds: 6,
  maxRounds: 12,
  status: 'ready',

  async setup(ctx) {
    const { data } = await supabase.from('story_seeds').select('genre, opening_line');
    const seeds = (data?.length ? data : FALLBACK_SEEDS) as { genre: string; opening_line: string }[];
    const order = shuffle(ctx.players.map((p) => p.id));
    const deck = shuffle(seeds); // all different while there are enough seeds
    const stories: Record<string, Story> = {};
    order.forEach((pid, i) => {
      const seed = deck[i % deck.length];
      stories[pid] = { genre: seed.genre, opening: seed.opening_line, lines: [] };
    });
    await ctx.saveRun({ order, stories });
  },

  startRound: writeStep,

  async next(ctx) {
    const step = ctx.room.state.step;
    const st = ctx.run.state as RunState;
    if (step === 'write') {
      await collect(ctx);
      if (ctx.room.round < ctx.room.rounds_total) return ctx.endRound();
      return showStory(ctx, 0, 1);
    }
    const idx = Number(ctx.room.state.idx ?? 0);
    const shown = Number(ctx.room.state.shown ?? 1);
    if (step === 'read') return showStory(ctx, idx, shown + 1);
    if (step === 'authors') {
      if (idx + 1 < (st.order?.length ?? 0)) return showStory(ctx, idx + 1, 1);
      return ctx.endRound();
    }
  },

  /** "Skip" during the finale skips the rest of this reading. */
  async skip(ctx) {
    const step = ctx.room.state.step;
    const idx = Number(ctx.room.state.idx ?? 0);
    if (step === 'read') return showStory(ctx, idx, 9999);
    if (step === 'authors') return this.next(ctx);
    await ctx.removeSubs(ctx.roundSubs().map((s) => s.id));
    await writeStep(ctx);
  },

  ready(ctx) {
    if (ctx.room.state.step !== 'write') return false;
    const st = ctx.run.state as RunState;
    const order = st.order ?? [];
    const holders = new Set(order.map((_, s) => holderOf(order, s, ctx.room.round)));
    const sent = new Set(ctx.roundSubs('line').map((s) => s.player_id));
    const active = ctx.players.filter((p) => p.connected && holders.has(p.id));
    return active.length > 0 && active.every((p) => sent.has(p.id));
  },

  TV: StoryTV,
  Phone: StoryPhone,
};

function StoryTV({ room, players }: TVGameProps) {
  const step = room.state.step;
  const map = new Map(players.map((p) => [p.id, p]));
  const done = (room.state.done ?? []).length;

  if (step === 'write') {
    const final = Boolean(room.state.final);
    return (
      <div className="center-stack story-stage">
        {final ? <h1 className="display huge">WRAP IT UP!</h1> : <h1 className="display">Keep the story going</h1>}
        <p className="lead">
          {final ? 'Give your story an ending. ' : 'Add two lines to the story on your phone. '}
          You only see the last line, so make it count.
        </p>
        <p className="lead dim">{done} of {players.length} done</p>
      </div>
    );
  }

  const texts = (room.state.texts as string[]) ?? [];
  const shown = Number(room.state.shown ?? 1);
  const authors = (room.state.authors as (string | null)[] | undefined) ?? [];
  const reader = map.get(String(room.state.starter ?? ''));
  const revealed = step === 'authors';

  return <StoryReader key={String(room.state.idx)} texts={texts} shown={shown} authors={authors} reader={reader} genre={String(room.state.genre ?? '')} revealed={revealed} map={map} idx={Number(room.state.idx)} total={Number(room.state.total)} />;
}

function StoryReader({
  texts, shown, authors, reader, genre, revealed, map, idx, total,
}: {
  texts: string[]; shown: number; authors: (string | null)[]; reader?: Player; genre: string; revealed: boolean; map: Map<string, Player>; idx: number; total: number;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [shown, revealed]);
  return (
    <div className="story-reader">
      <header className="story-header">
        <div className="dim">Story {idx + 1} of {total}</div>
        <div className="story-genre">{genre}</div>
        {reader && (
          <div className="story-reader-name">
            <span>Read aloud by</span> <PlayerChip player={reader} size="lg" />
          </div>
        )}
      </header>
      <div className="story-scroll">
        {texts.slice(0, shown).map((t, i) => {
          const by = revealed ? authors[i] : null;
          const author = by ? map.get(by) : null;
          const starter = i === 0;
          return (
            <p key={i} className="story-line pop-in" style={author ? { borderLeftColor: author.color } : undefined}>
              {t}
              {revealed && (
                <span className="story-by">
                  {starter ? <span className="dim">opening line</span> : author ? <PlayerChip player={author} size="sm" /> : <span className="dim">someone who left</span>}
                </span>
              )}
            </p>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function StoryPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;

  if (step === 'write') return <Writer room={room} api={api} />;

  const texts = (room.state.texts as string[]) ?? [];
  const reader = players.find((p) => p.id === room.state.starter);
  const youRead = reader?.id === me.id;
  return (
    <div className="stack gap">
      {youRead ? (
        <div className="card center-stack">
          <h2>📣 This one is yours!</h2>
          <p>Read it aloud when the host is ready. Authors are revealed afterwards.</p>
        </div>
      ) : (
        <div className="center-stack">
          <p className="dim">Now reading</p>
          {reader && <PlayerChip player={reader} size="lg" />}
        </div>
      )}
      <div className="story-phone">
        {texts.slice(0, Number(room.state.shown ?? 1)).map((t, i) => (
          <p key={i}>{t}</p>
        ))}
      </div>
      {step === 'authors' && (
        <p className="center dim">Authors are on the TV. Look for your color!</p>
      )}
    </div>
  );
}

function Writer({ room, api }: Pick<PhoneGameProps, 'room' | 'api'>) {
  const prompt = api.mySubs.find((s) => s.kind === 'prompt')?.payload as { genre?: string; lastLine?: string; final?: boolean } | undefined;
  const mine = api.mySubs.find((s) => s.kind === 'line');
  const key = `partypack:story:${room.current_run_id}:${room.round}`;
  const [lines, setLines] = useState<string[]>(() => load<string[]>(key, ['', '']));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const sentAuto = useRef(false);

  const send = async () => {
    const l = linesRef.current.map((x) => x.trim());
    if (!l[0] && !l[1]) return;
    setBusy(true);
    setErr(null);
    try {
      await api.submit('line', { lines: l });
    } catch (e) {
      setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Time is up!' : errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, v: string) => {
    const next = [...lines];
    next[i] = v;
    setLines(next);
    save(key, next);
  };

  // Don't lose half-written lines: auto-send a moment before the timer ends.
  useEffect(() => {
    const id = window.setInterval(() => {
      const left = secondsLeft(room.timer_ends_at);
      if (left != null && left <= 3 && left > 0 && !sentAuto.current && !mine) {
        sentAuto.current = true;
        void send();
      }
    }, 500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.timer_ends_at, mine]);

  if (!prompt) {
    return (
      <div className="phone-center center-stack">
        <h2>Sit this one out</h2>
        <p className="dim">You joined after this game started. Watch the TV, you will be in the next one.</p>
      </div>
    );
  }

  return (
    <div className="stack gap">
      <div className="story-genre-card">{prompt.genre}</div>
      <div className="card">
        <p className="dim small">The story so far ends with…</p>
        <p className="story-last">“{prompt.lastLine}”</p>
      </div>
      {prompt.final && <p className="center error">Final round: wrap it up!</p>}
      {[0, 1].map((i) => (
        <textarea
          key={i}
          className="input"
          rows={3}
          maxLength={MAX_LINE}
          value={lines[i]}
          onChange={(e) => update(i, e.target.value)}
          placeholder={i === 0 ? 'Next line…' : prompt.final ? 'And the ending…' : 'And one more…'}
        />
      ))}
      <button className="btn btn-primary btn-lg" disabled={busy || (!lines[0].trim() && !lines[1].trim())} onClick={() => void send()}>
        {mine ? 'Update lines' : 'Send lines'}
      </button>
      {mine && <p className="center dim">Sent! You can still edit until time runs out.</p>}
      {err && <p className="error center">{err}</p>}
    </div>
  );
}
