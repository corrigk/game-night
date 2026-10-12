import { teamTotals } from '../lib/teams';
import type { Player, RoomSettings } from '../lib/types';

/** Team totals (sum of members' scores). Renders nothing when teams are off. */
export function TeamStandings({ players, settings }: { players: Player[]; settings: RoomSettings }) {
  const totals = teamTotals(players, settings);
  if (!totals.length) return null;
  const max = Math.max(1, ...totals.map((t) => t.total));
  return (
    <div className="team-standings">
      <h2 className="leaderboard-title">Teams</h2>
      <ol>
        {totals.map((t) => (
          <li key={t.index}>
            <span className="team-name" style={{ ['--tc' as string]: t.color }}>
              {t.emoji} {t.name}
            </span>
            <span className="team-bar">
              <i style={{ width: `${(t.total / max) * 100}%`, background: t.color }} />
            </span>
            <span className="lb-score">{t.total.toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
