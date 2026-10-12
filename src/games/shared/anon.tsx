import { useState, type ReactNode } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { errorCode } from '../../lib/supabase';
import type { Player } from '../../lib/types';
import type { GameCtx, PhoneApi } from '../types';

/**
 * Shared pieces for the "everyone submits something, everyone votes anonymously, authors are
 * revealed" games (Acronym Attack, Plot Twist, Fake Headlines). Same flow as Weird Facts and
 * Caption This: submissions are plain rows, votes target a submission id, and the database refuses
 * a vote for your own submission.
 */

export interface AnonItem {
  id: string;
  text: string;
  authorId: string | null;
  votes: number;
}

/** Tally one submission kind against one vote kind for the current round, best first. */
export function tallyAnonymous(ctx: GameCtx, subKind: string, voteKind: string, textOf: (payload: Record<string, unknown>) => string): AnonItem[] {
  const ids = new Set(ctx.players.map((p) => p.id));
  const votes = ctx.roundVotes(voteKind);
  return ctx
    .roundSubs(subKind)
    .map((s) => ({
      id: s.id,
      text: textOf(s.payload).trim(),
      authorId: s.player_id && ids.has(s.player_id) ? s.player_id : null,
      votes: votes.filter((v) => v.target_submission_id === s.id).length,
    }))
    .filter((i) => i.text)
    .sort((a, b) => b.votes - a.votes);
}

/** Ids of everyone tied for the most votes (none if nobody got any). */
export function topIds(items: { id: string; votes: number }[]): string[] {
  const top = Math.max(0, ...items.map((i) => i.votes));
  return top > 0 ? items.filter((i) => i.votes === top).map((i) => i.id) : [];
}

// ---------------------------------------------------------------- TV
/** Anonymous, shuffled options on the TV. `render` styles each one (cards, chyrons, ...). */
export function AnonOptions({ options, render }: { options: { id: string; text: string }[]; render?: (o: { id: string; text: string }) => ReactNode }) {
  return (
    <div className="anon-list">
      {options.map((o, i) => (
        <div key={o.id} className="anon-card pop-in" style={{ animationDelay: `${i * 70}ms` }}>
          {render ? render(o) : o.text}
        </div>
      ))}
    </div>
  );
}

/** Reveal: authors unmasked, winner(s) highlighted, points shown. */
export function RevealList({
  items,
  winners,
  players,
  pointsFor,
  label = 'Winner',
  render,
}: {
  items: AnonItem[];
  winners: string[];
  players: Player[];
  pointsFor: (item: AnonItem, isWinner: boolean) => number;
  label?: string;
  render?: (text: string) => ReactNode;
}) {
  const map = new Map(players.map((p) => [p.id, p]));
  const ordered = [...items.filter((i) => winners.includes(i.id)), ...items.filter((i) => !winners.includes(i.id))];
  return (
    <div className="anon-list">
      {items.length === 0 && <p className="lead">Nothing came in this round.</p>}
      {ordered.map((it, i) => {
        const win = winners.includes(it.id);
        const author = it.authorId ? map.get(it.authorId) : null;
        const pts = pointsFor(it, win);
        return (
          <div key={it.id} className={`anon-card pop-in${win ? ' anon-winner' : ''}`} style={{ animationDelay: `${i * 90}ms` }}>
            {win && <div className="anon-winner-label">🏆 {winners.length > 1 ? 'Tie! ' : ''}{label}</div>}
            <div>{render ? render(it.text) : it.text}</div>
            <div className="anon-meta">
              {author ? <PlayerChip player={author} size={win ? 'md' : 'sm'} /> : <span className="dim">someone who left</span>}
              <span className={pts ? 'points' : 'dim'}>
                {it.votes} vote{it.votes === 1 ? '' : 's'}
                {pts ? ` · +${pts}` : ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- phone
/** Tap-to-vote list. Your own submission is shown but locked (the database also refuses it). */
export function VoteList({
  options,
  mineId,
  kind,
  api,
  render,
}: {
  options: { id: string; text: string }[];
  mineId?: string;
  kind: string;
  api: PhoneApi;
  render?: (text: string) => ReactNode;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const picked = pending ?? api.myVotes.find((v) => v.kind === kind)?.target_submission_id ?? null;
  return (
    <div className="stack gap">
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
                .vote(kind, { submissionId: o.id })
                .catch((e) => setErr(errorCode(e) === 'OWN_SUBMISSION' ? "You can't vote for your own." : errorCode(e) === 'NOT_ACCEPTING' ? 'Voting just closed.' : errorCode(e)))
                .finally(() => setPending(null));
            }}
          >
            {render ? render(o.text) : o.text}
            {own && <span className="dim small"> (yours)</span>}
          </button>
        );
      })}
      {picked && <p className="center dim">Vote locked in. Tap another to change it.</p>}
      {err && <p className="error center">{err}</p>}
    </div>
  );
}
