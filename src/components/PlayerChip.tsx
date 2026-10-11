import type { CSSProperties } from 'react';
import { textOn } from '../config';
import type { Player } from '../lib/types';

type Size = 'sm' | 'md' | 'lg' | 'xl';

/** A player's emoji + name on their color. Always a filled chip, so it reads on any theme. */
export function PlayerChip({
  player,
  size = 'md',
  dim = false,
  hideName = false,
}: {
  player: Pick<Player, 'name' | 'emoji' | 'color'>;
  size?: Size;
  dim?: boolean;
  hideName?: boolean;
}) {
  const style = { '--pc': player.color, '--pc-text': textOn(player.color) } as CSSProperties;
  return (
    <span className={`chip chip-${size}${dim ? ' chip-dim' : ''}`} style={style} title={player.name}>
      <span className="chip-emoji">{player.emoji}</span>
      {!hideName && <span className="chip-name">{player.name}</span>}
    </span>
  );
}

/** Round emoji badge on the player's color. */
export function Avatar({ player, size = 'md', dim = false }: { player: Pick<Player, 'emoji' | 'color' | 'name'>; size?: Size; dim?: boolean }) {
  const style = { '--pc': player.color } as CSSProperties;
  return (
    <span className={`avatar avatar-${size}${dim ? ' chip-dim' : ''}`} style={style} title={player.name}>
      {player.emoji}
    </span>
  );
}
