import { EMOJIS, PLAYER_COLORS, textOn } from '../config';
import type { Player } from '../lib/types';
import { PlayerChip } from '../components/PlayerChip';

/** Emoji + color picker. Colors already used by someone else are disabled. */
export function LookPicker({
  name,
  emoji,
  color,
  takenColors,
  onChange,
}: {
  name: string;
  emoji: string;
  color: string;
  takenColors: Set<string>;
  onChange: (look: { emoji: string; color: string }) => void;
}) {
  return (
    <div className="stack gap">
      <div className="center-stack">
        <PlayerChip player={{ name, emoji, color }} size="xl" />
      </div>
      <h3>Pick an emoji</h3>
      <div className="emoji-grid">
        {EMOJIS.map((e) => (
          <button
            key={e}
            className={`emoji-option${e === emoji ? ' active' : ''}`}
            onClick={() => onChange({ emoji: e, color })}
            aria-label={`Emoji ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
      <h3>Pick a color</h3>
      <div className="color-grid">
        {PLAYER_COLORS.map((c) => {
          const taken = takenColors.has(c.hex.toLowerCase());
          return (
            <button
              key={c.hex}
              className={`color-option${c.hex === color ? ' active' : ''}`}
              style={{ background: c.hex, color: textOn(c.hex) }}
              disabled={taken}
              onClick={() => onChange({ emoji, color: c.hex })}
              aria-label={`${c.name}${taken ? ' (taken)' : ''}`}
              title={c.name}
            >
              {taken ? '✕' : c.hex === color ? '✓' : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function takenColorsFor(players: Player[], exceptId?: string): Set<string> {
  return new Set(players.filter((p) => p.id !== exceptId).map((p) => p.color.toLowerCase()));
}

export function randomFreeLook(players: Player[]) {
  const taken = takenColorsFor(players);
  const free = PLAYER_COLORS.filter((c) => !taken.has(c.hex.toLowerCase()));
  const color = (free.length ? free : PLAYER_COLORS)[Math.floor(Math.random() * (free.length || PLAYER_COLORS.length))].hex;
  const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  return { emoji, color };
}
