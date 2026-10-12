import type { CSSProperties } from 'react';
import { textOn } from '../config';
import { useTeams } from '../lib/teamsContext';
import type { Player } from '../lib/types';

type Size = 'sm' | 'md' | 'lg' | 'xl';

/** A colored ring marking the player's team (nothing when they have none). */
function useTeamColor(player: Partial<Pick<Player, 'team_id'>>): string | undefined {
  const teams = useTeams();
  return player.team_id ? teams.find((t) => t.id === player.team_id)?.color : undefined;
}

/** A player's emoji + name on their color. Always a filled chip, so it reads on any theme. */
export function PlayerChip({
  player,
  size = 'md',
  dim = false,
  hideName = false,
}: {
  player: Pick<Player, 'name' | 'emoji' | 'color'> & Partial<Pick<Player, 'team_id'>>;
  size?: Size;
  dim?: boolean;
  hideName?: boolean;
}) {
  const team = useTeamColor(player);
  const style = { '--pc': player.color, '--pc-text': textOn(player.color), ...(team ? { '--tc': team } : {}) } as CSSProperties;
  return (
    <span className={`chip chip-${size}${dim ? ' chip-dim' : ''}${team ? ' has-team' : ''}`} style={style} title={player.name}>
      <span className="chip-emoji">{player.emoji}</span>
      {!hideName && <span className="chip-name">{player.name}</span>}
    </span>
  );
}

/** Round emoji badge on the player's color. */
export function Avatar({ player, size = 'md', dim = false }: { player: Pick<Player, 'emoji' | 'color' | 'name'> & Partial<Pick<Player, 'team_id'>>; size?: Size; dim?: boolean }) {
  const team = useTeamColor(player);
  const style = { '--pc': player.color, ...(team ? { '--tc': team } : {}) } as CSSProperties;
  return (
    <span className={`avatar avatar-${size}${dim ? ' chip-dim' : ''}${team ? ' has-team' : ''}`} style={style} title={player.name}>
      {player.emoji}
    </span>
  );
}
