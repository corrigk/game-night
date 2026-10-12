import { useEffect, useState } from 'react';
import { DEFAULT_ROSTER } from '../config';
import { Confirm } from '../components/Modal';
import { Avatar } from '../components/PlayerChip';
import { GAMES } from '../games/registry';
import { isMuted, onMuteChange, setMuted } from '../lib/sound';
import type { Player, Room } from '../lib/types';
import { THEMES } from '../themes/themes';
import { balancedAssign, TEAM_DEFS, teamsOf } from '../lib/teams';
import type { EngineSnapshot, HostEngine } from './engine';

type Pending =
  | { kind: 'hub' }
  | { kind: 'end' }
  | { kind: 'kick'; player: Player }
  | { kind: 'newRoom' }
  | { kind: 'veto' }
  | null;

export function HostDrawer({
  open,
  onClose,
  onShowQr,
  room,
  players,
  online,
  engine,
  engineSnap,
  onNewRoom,
}: {
  open: boolean;
  onClose: () => void;
  onShowQr: () => void;
  room: Room;
  players: Player[];
  online: Set<string>;
  engine: HostEngine;
  engineSnap: EngineSnapshot;
  onNewRoom: () => Promise<void>;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [muted, setMutedState] = useState(isMuted());
  const [roster, setRoster] = useState((room.settings.roster ?? DEFAULT_ROSTER).join('\n'));
  const inGame = room.phase === 'intro' || room.phase === 'play';
  const teams = teamsOf(room.settings);
  const game = room.current_game ? GAMES[room.current_game] : undefined;

  useEffect(() => onMuteChange(setMutedState), []);
  useEffect(() => {
    setRoster((room.settings.roster ?? DEFAULT_ROSTER).join('\n'));
  }, [room.settings.roster]);

  return (
    <>
      <div className={`drawer-scrim${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>Host controls</h2>
          <button className="btn btn-sm" onClick={onClose}>Close (H)</button>
        </div>

        {engineSnap.error && (
          <button className="drawer-error" onClick={engine.clearError}>
            ⚠ {engineSnap.error} · dismiss
          </button>
        )}

        <section>
          <h3>
            {game ? `${game.emoji} ${game.title}` : phaseLabel(room.phase)}
            {inGame && (
              <span className="dim">
                {' '}
                · round {room.round}/{room.rounds_total}
                {room.state.step ? ` · ${String(room.state.step)}` : ''}
              </span>
            )}
          </h3>
          <div className="drawer-grid">
            <button className="btn btn-primary" onClick={() => void engine.next()}>Next <kbd>Space</kbd></button>
            <button className="btn" onClick={() => void engine.skip()} disabled={room.phase !== 'play'}>Skip prompt</button>
            <button className="btn" onClick={() => void engine.togglePause()} disabled={room.phase !== 'play'}>
              {room.state.paused ? '▶ Resume' : '⏸ Pause'} <kbd>P</kbd>
            </button>
            <button className="btn" onClick={() => setPending({ kind: 'veto' })} disabled={room.phase !== 'play'}>
              Skip &amp; never show again
            </button>
            <button className="btn" onClick={() => void engine.addTime(15)} disabled={!room.timer_ends_at}>+15s <kbd>+</kbd></button>
            <button className="btn" onClick={() => void engine.addRound()} disabled={!inGame}>+1 round</button>
            <button className="btn" onClick={() => setPending({ kind: 'end' })} disabled={!inGame}>End game early</button>
            <button className="btn btn-danger" onClick={() => setPending({ kind: 'hub' })} disabled={room.phase === 'hub' || room.phase === 'lobby'}>
              Back to hub
            </button>
          </div>
          {room.phase === 'lobby' && <p className="dim small">Next opens the game hub.</p>}
        </section>

        <section>
          <h3>Display</h3>
          <div className="theme-list">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-option${(room.settings.theme ?? 'neon') === t.id ? ' active' : ''}`}
                onClick={() => void engine.updateSettings({ theme: t.id })}
              >
                <span className="swatches">
                  {t.swatch.map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
                {t.name}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Caption This: friend photos {Math.round(Number(room.settings.captionFriendMix ?? 0.3) * 100)}%</span>
            <input
              type="range"
              min={0}
              max={100}
              step={10}
              value={Math.round(Number(room.settings.captionFriendMix ?? 0.3) * 100)}
              onChange={(e) => void engine.updateSettings({ captionFriendMix: Number(e.target.value) / 100 })}
            />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} />
            Sound effects {muted ? '(muted)' : 'on'}
          </label>
        </section>

        <section>
          <h3>
            Players <span className="dim">({players.length})</span>
          </h3>
          <ul className="drawer-players">
            {players.map((p) => (
              <li key={p.id}>
                <span className={`dot ${online.has(p.id) ? 'dot-on' : 'dot-off'}`} title={online.has(p.id) ? 'Connected' : 'Offline'} />
                <Avatar player={p} size="sm" />
                <span className="grow">{p.name}</span>
                {teams && (
              <select
                className="team-select"
                value={teams.assign[p.id] ?? 0}
                onChange={(e) => void engine.updateSettings({ teams: { ...teams, assign: { ...teams.assign, [p.id]: Number(e.target.value) } } })}
              >
                {TEAM_DEFS.slice(0, teams.count).map((t, i) => (
                  <option key={t.name} value={i}>{t.emoji} {t.name}</option>
                ))}
              </select>
            )}
            <span className="dim">{p.score}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setPending({ kind: 'kick', player: p })}>Kick</button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3>Teams</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={Boolean(teams)}
              onChange={(e) =>
                void engine.updateSettings({
                  teams: e.target.checked
                    ? { enabled: true, count: (room.settings.teams as { count?: number } | undefined)?.count ?? 2, assign: balancedAssign(players, (room.settings.teams as { count?: number } | undefined)?.count ?? 2) }
                    : { ...(room.settings.teams as object), enabled: false },
                })
              }
            />
            Play in teams (scores add up per team)
          </label>
          {teams && (
            <div className="row gap wrap">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  className={`btn btn-sm${teams.count === n ? ' btn-primary' : ''}`}
                  onClick={() => void engine.updateSettings({ teams: { enabled: true, count: n, assign: balancedAssign(players, n) } })}
                >
                  {n} teams
                </button>
              ))}
              <button className="btn btn-sm" onClick={() => void engine.updateSettings({ teams: { ...teams, assign: balancedAssign(players, teams.count) } })}>
                Shuffle
              </button>
            </div>
          )}
        </section>

        <section>
          <h3>Join roster</h3>
          <p className="dim small">Names shown as buttons on the phone join screen. One per line.</p>
          <textarea className="input" rows={6} value={roster} onChange={(e) => setRoster(e.target.value)} />
          <button
            className="btn btn-sm"
            onClick={() =>
              void engine.updateSettings({
                roster: roster.split('\n').map((s) => s.trim()).filter(Boolean),
              })
            }
          >
            Save roster
          </button>
        </section>

        <section>
          <h3>Room {room.code}</h3>
          <div className="row gap wrap">
            <button className="btn btn-sm" onClick={onShowQr}>Big QR <kbd>Q</kbd></button>
            <a className="btn btn-sm" href="/admin" target="_blank" rel="noreferrer">Open admin</a>
            <button className="btn btn-sm btn-danger" onClick={() => setPending({ kind: 'newRoom' })}>Hard reset</button>
          </div>
          <p className="dim small">
            Shortcuts: <kbd>H</kbd> drawer · <kbd>Space</kbd> next · <kbd>+</kbd> add 15s · <kbd>Q</kbd> big QR · <kbd>P</kbd> pause
          </p>
        </section>
      </aside>

      {pending?.kind === 'hub' && (
        <Confirm
          title="Back to the hub?"
          body="This game stops now. Points already earned are kept."
          confirmLabel="Back to hub"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void engine.backToHub();
          }}
        />
      )}
      {pending?.kind === 'end' && (
        <Confirm
          title="End this game early?"
          body="Skips the remaining rounds and shows results. Points are kept."
          confirmLabel="Show results"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void engine.endGameEarly();
          }}
        />
      )}
      {pending?.kind === 'kick' && (
        <Confirm
          title={`Kick ${pending.player.name}?`}
          body="Removes them and their points. They can rejoin as a new player."
          confirmLabel="Kick"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.player.id;
            setPending(null);
            void engine.kick(id);
          }}
        />
      )}
      {pending?.kind === 'veto' && (
        <Confirm
          title="Skip and never show this again?"
          body="Retires this prompt, photo or talent from the bank (you can restore it in /admin) and deals a fresh one."
          confirmLabel="Skip and retire"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void engine.vetoSkip();
          }}
        />
      )}
      {pending?.kind === 'newRoom' && (
        <Confirm
          title="Hard reset?"
          body="Throws away this room and starts a fresh lobby with a new code and QR. Everyone has to join again and scores start from zero."
          confirmLabel="Hard reset"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void onNewRoom();
          }}
        />
      )}
    </>
  );
}

function phaseLabel(phase: Room['phase']) {
  return { lobby: 'Lobby', hub: 'Game hub', intro: 'Intro', play: 'Playing', results: 'Results', awards: 'Awards' }[phase];
}
