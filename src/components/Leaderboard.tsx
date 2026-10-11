import type { Player } from '../lib/types';
import { Avatar } from './PlayerChip';

/** Cumulative leaderboard for the night (players.score is maintained from score_events). */
export function Leaderboard({
  players,
  highlightId,
  limit,
  title = 'Leaderboard',
}: {
  players: Player[];
  highlightId?: string;
  limit?: number;
  title?: string;
}) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const rows = limit ? sorted.slice(0, limit) : sorted;
  let rank = 0;
  let prev: number | null = null;
  return (
    <div className="leaderboard">
      <h2 className="leaderboard-title">{title}</h2>
      {rows.length === 0 && <p className="dim">No players yet</p>}
      <ol>
        {rows.map((p, i) => {
          if (p.score !== prev) rank = i + 1;
          prev = p.score;
          return (
            <li key={p.id} className={p.id === highlightId ? 'is-me' : undefined}>
              <span className="lb-rank">{rank}</span>
              <Avatar player={p} size="sm" dim={!p.connected} />
              <span className="lb-name">{p.name}</span>
              <span className="lb-score">{p.score.toLocaleString()}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
