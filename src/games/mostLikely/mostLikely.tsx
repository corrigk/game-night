import { useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { leastUsed, loadBank, markUsed } from '../../lib/bank';
import { errorCode } from '../../lib/supabase';
import type { Player } from '../../lib/types';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';

/**
 * Most Likely To: the TV shows a prompt, everyone votes for a player (self-vote
 * allowed), then the winner is revealed. Voters who matched the majority score.
 */

const MATCH_POINTS = 100;
const VOTE_SECONDS = 30;
const KIND = 'mlt';

const FALLBACK = [
  'Most likely to forget their own birthday',
  'Most likely to survive a zombie apocalypse',
  'Most likely to cry at a commercial',
  'Most likely to adopt 12 cats',
];

interface Prompt {
  id?: string;
  text: string;
}

interface RevealState {
  counts: Record<string, number>;
  winners: string[];
  matched: string[];
  points: number;
}

const shuffle = <T,>(list: T[]): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Prompts are stored as full sentences ("Most likely to …"); show just the tail big. */
const tail = (prompt: string) => prompt.replace(/^\s*most likely to\s*/i, '');

async function reveal(ctx: GameCtx) {
  const ids = new Set(ctx.players.map((p) => p.id));
  const counts: Record<string, number> = {};
  const votes = ctx.roundVotes(KIND).filter((v) => v.target_player_id && ids.has(v.target_player_id));
  for (const v of votes) counts[v.target_player_id!] = (counts[v.target_player_id!] ?? 0) + 1;
  const top = Math.max(0, ...Object.values(counts));
  const winners = top > 0 ? Object.keys(counts).filter((id) => counts[id] === top) : [];
  // Matching only means something if at least two people agreed.
  const matched = top >= 2 ? votes.filter((v) => winners.includes(v.target_player_id!)).map((v) => v.voter_id) : [];
  await ctx.award(matched.map((playerId) => ({ playerId, points: MATCH_POINTS, reason: 'Most Likely To: matched the majority' })));
  await ctx.setStep('reveal', { prompt: ctx.room.state.prompt, counts, winners, matched, points: MATCH_POINTS });
}

export const mostLikely: GameModule = {
  id: 'most_likely',
  title: 'Most Likely To',
  emoji: '👉',
  tagline: 'Point fingers. Anonymously-ish.',
  rules: [
    'A prompt appears on the TV.',
    'Vote for the player it fits best. Yes, you can vote for yourself.',
    'Vote with the majority and you score.',
  ],
  scored: true,
  defaultRounds: 8,
  maxRounds: 40,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<{ id: string; text: string; times_used?: number }>('most_likely_prompts');
    const deck = rows.length ? leastUsed(rows).map((r) => ({ id: r.id, text: String(r.text) })) : FALLBACK.map((text) => ({ text }));
    await ctx.saveRun({ deck, cursor: 0 });
  },

  async startRound(ctx) {
    const state = ctx.run.state as { deck?: Prompt[]; cursor?: number };
    let deck: Prompt[] = state.deck?.length ? state.deck : FALLBACK.map((text) => ({ text }));
    let cursor = state.cursor ?? 0;
    if (cursor >= deck.length) {
      deck = shuffle(deck); // more rounds than prompts: reshuffle and go again
      cursor = 0;
    }
    const item = deck[cursor];
    markUsed('most_likely_prompts', [item.id]);
    await ctx.saveRun({ deck, cursor: cursor + 1, cur: item.id ? { table: 'most_likely_prompts', id: item.id } : null });
    await ctx.setStep('vote', { prompt: item.text }, { seconds: VOTE_SECONDS, vote: [KIND] });
  },

  async next(ctx) {
    if (ctx.room.state.step === 'vote') await reveal(ctx);
    else await ctx.endRound();
  },

  // Move on as soon as everyone who is connected has voted.
  ready(ctx) {
    if (ctx.room.state.step !== 'vote') return false;
    const voted = new Set(ctx.roundVotes(KIND).map((v) => v.voter_id));
    const active = ctx.players.filter((p) => p.connected);
    return active.length > 0 && active.every((p) => voted.has(p.id));
  },

  TV: MostLikelyTV,
  Phone: MostLikelyPhone,
};

function PromptHeading({ prompt }: { prompt: string }) {
  return (
    <div className="mlt-prompt">
      <div className="mlt-kicker">Most likely to…</div>
      <h1 className="display mlt-text">{tail(prompt)}</h1>
    </div>
  );
}

function MostLikelyTV({ room, players }: TVGameProps) {
  const prompt = String(room.state.prompt ?? '');
  const map = new Map(players.map((p) => [p.id, p]));

  if (room.state.step === 'vote') {
    const done = (room.state.done ?? []).length;
    return (
      <div className="center-stack mlt-stage">
        <PromptHeading prompt={prompt} />
        <p className="lead dim">
          {done} of {players.length} voted. Vote on your phone!
        </p>
      </div>
    );
  }

  const r = room.state as unknown as RevealState;
  const winners = r.winners.map((id) => map.get(id)).filter((p): p is Player => Boolean(p));
  const rows = Object.entries(r.counts)
    .map(([id, n]) => ({ player: map.get(id), n }))
    .filter((x): x is { player: Player; n: number } => Boolean(x.player))
    .sort((a, b) => b.n - a.n);
  const max = rows[0]?.n ?? 1;

  return (
    <div className="center-stack mlt-stage">
      {winners.length === 0 ? (
        <>
          <PromptHeading prompt={prompt} />
          <p className="lead">Nobody voted. The room is suspiciously quiet.</p>
        </>
      ) : (
        <>
          {winners.length > 1 && <div className="mlt-kicker">It's a tie!</div>}
          <div className="mlt-winners">
            {winners.map((p) => (
              <div key={p.id} className="mlt-winner pop-in" style={{ ['--pc' as string]: p.color }}>
                <PlayerChip player={p} size="xl" />
              </div>
            ))}
          </div>
          <div className="mlt-kicker">Most likely to…</div>
          <h1 className="display mlt-text">{tail(prompt)}</h1>
        </>
      )}
      <ol className="mlt-bars">
        {rows.map((row, i) => (
          <li key={row.player.id} className="pop-in" style={{ animationDelay: `${0.3 + i * 0.12}s` }}>
            <PlayerChip player={row.player} size="md" />
            <span className="mlt-bar">
              <i style={{ width: `${(row.n / max) * 100}%`, background: row.player.color }} />
            </span>
            <span className="mlt-count">{row.n}</span>
          </li>
        ))}
      </ol>
      {r.matched.length > 0 && (
        <p className="lead dim">
          {r.matched.length} voter{r.matched.length === 1 ? '' : 's'} matched the majority: +{r.points}
        </p>
      )}
    </div>
  );
}

function MostLikelyPhone({ room, me, players, api }: PhoneGameProps) {
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const prompt = String(room.state.prompt ?? '');
  const mine = api.myVotes.find((v) => v.kind === KIND)?.target_player_id ?? null;

  if (room.state.step === 'vote') {
    const picked = pending ?? mine;
    return (
      <div className="stack gap">
        <PromptHeading prompt={prompt} />
        <div className="vote-grid">
          {players.map((p) => (
            <button
              key={p.id}
              className={`vote-option${picked === p.id ? ' selected' : ''}`}
              onClick={() => {
                setErr(null);
                setPending(p.id);
                api
                  .vote(KIND, { playerId: p.id })
                  .catch((e) => setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Voting just closed.' : errorCode(e)))
                  .finally(() => setPending(null));
              }}
            >
              <PlayerChip player={p} size="md" />
            </button>
          ))}
        </div>
        <p className="center dim">{mine ? 'Vote locked in. Tap someone else to change it.' : 'Tap who it fits best.'}</p>
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  const r = room.state as unknown as RevealState;
  const matched = r.matched.includes(me.id);
  const winners = r.winners.map((id) => players.find((p) => p.id === id)).filter((p): p is Player => Boolean(p));
  return (
    <div className="phone-center center-stack">
      {winners.map((p) => (
        <PlayerChip key={p.id} player={p} size="xl" />
      ))}
      <div className="mlt-kicker">Most likely to…</div>
      <h2>{tail(prompt)}</h2>
      {matched ? <p className="points big-num">+{r.points}</p> : <p className="dim">{mine ? 'You went against the room.' : 'You skipped this one.'}</p>}
    </div>
  );
}
