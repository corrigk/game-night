import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Countdown } from '../components/Countdown';
import { Leaderboard } from '../components/Leaderboard';
import { TeamStandings } from '../components/TeamStandings';
import { teamTotals } from '../lib/teams';
import { Modal } from '../components/Modal';
import { Avatar, PlayerChip } from '../components/PlayerChip';
import { GAME_LIST, GAMES } from '../games/registry';
import type { GameModule } from '../games/types';
import { play } from '../lib/sound';
import type { Player, Room, Team } from '../lib/types';
import type { Award } from './awards';
import type { EngineSnapshot, HostEngine } from './engine';

interface Props {
  room: Room;
  players: Player[];
  teams: Team[];
  openTeams: () => void;
  engine: HostEngine;
  engineSnap: EngineSnapshot;
  online: Set<string>;
}

export function joinUrl(code: string) {
  return `${window.location.origin}/play?code=${code}`;
}

/** Occasional sound effects: a pop when someone answers, a sting on reveals, fanfare for winners. */
function useSfx(room: Room) {
  const step = String(room.state.step ?? '');
  const done = (room.state.done ?? []).length;
  const prevDone = useRef(0);
  const stage = Number(room.state.stage ?? 0);

  useEffect(() => {
    if (room.phase === 'play' && done > prevDone.current) play('pop');
    prevDone.current = done;
  }, [room.phase, done]);

  useEffect(() => {
    if (room.phase === 'results') play('fanfare');
    else if (room.phase === 'awards') play('fanfare');
    else if (room.phase === 'play' && ['reveal', 'top3', 'authors'].includes(step)) play('sting');
  }, [room.phase, step, stage, room.round]);
}

export function TVScreens(props: Props) {
  const { room } = props;
  useSfx(room);
  switch (room.phase) {
    case 'lobby':
      return <Lobby {...props} />;
    case 'hub':
      return <Hub {...props} />;
    case 'intro':
      return <Intro {...props} />;
    case 'play':
      return <Play {...props} />;
    case 'results':
      return <Results {...props} />;
    case 'awards':
      return <Awards {...props} />;
  }
}

// ----------------------------------------------------------------- lobby
function Lobby({ room, players, online }: Props) {
  const url = joinUrl(room.code);
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  return (
    <div className="screen lobby">
      <div className="lobby-join card">
        <p className="lobby-label">Join on your phone</p>
        <div className="qr">
          <QRCodeSVG value={url} size={512} marginSize={2} bgColor="#ffffff" fgColor="#000000" />
        </div>
        <p className="lobby-url">{url.replace(/^https?:\/\//, '').replace(/\?code=.*/, '')}</p>
        <p className="lobby-label">Room code</p>
        <div className="room-code">{room.code}</div>
        {isLocalhost && (
          <p className="warn">
            Phones can't reach "localhost". Open this page using your computer's network address (shown by
            <code> npm run dev</code>) or the deployed URL.
          </p>
        )}
      </div>
      <div className="lobby-players">
        <h1 className="display title-glow">Party Pack</h1>
        <p className="lead">{players.length === 0 ? 'Waiting for players…' : `${players.length} in the room`}</p>
        <div className="lobby-grid">
          {players.map((p) => (
            <div key={p.id} className="lobby-player pop-in">
              <PlayerChip player={p} size="lg" dim={!online.has(p.id)} />
            </div>
          ))}
        </div>
        <p className="tv-footer">Everyone in? Host presses <kbd>Space</kbd></p>
      </div>
    </div>
  );
}

/** Small corner badge so latecomers can always join. */
function JoinBadge({ code }: { code: string }) {
  return (
    <div className="join-badge" title="Press Q for a bigger QR">
      <QRCodeSVG value={joinUrl(code)} size={96} marginSize={1} bgColor="#ffffff" fgColor="#000000" />
      <div>
        <div className="dim small">Join</div>
        <div className="join-badge-code">{code}</div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- hub
function Hub({ room, players, teams, openTeams, engine, engineSnap }: Props) {
  const [picked, setPicked] = useState<GameModule | null>(null);
  const plays = (id: string) => engineSnap.runs.filter((r) => r.game_type === id && (r.status === 'done' || r.status === 'exited')).length;

  return (
    <div className="screen hub">
      <div className="hub-main">
        <h1 className="display title-glow">Pick a game</h1>
        <div className="hub-grid">
          {GAME_LIST.map((g) => {
            const n = plays(g.id);
            return (
              <button
                key={g.id}
                className={`tile${g.status === 'soon' ? ' tile-soon' : ''}${n ? ' tile-played' : ''}`}
                disabled={g.status === 'soon'}
                onClick={() => setPicked(g)}
              >
                <span className="tile-emoji">{g.emoji}</span>
                <span className="tile-title">{g.title}</span>
                <span className="tile-tagline">{g.status === 'soon' ? g.soonNote : g.tagline}</span>
                {n > 0 && <span className="tile-check" title={`Played ${n}×`}>✓{n > 1 ? ` ×${n}` : ''}</span>}
                {!g.scored && <span className="tile-badge">No points</span>}
              </button>
            );
          })}
        </div>
        <div className="row gap center">
          <button className="btn btn-lg" onClick={openTeams}>👥 Teams{teams.length ? ` (${teams.length})` : ''}</button>
          <button className="btn btn-lg" onClick={() => void engine.showAwards()}>🏆 Finish the night: Final Awards</button>
        </div>
        <p className="tv-footer dim">Host: click a game to start it</p>
      </div>
      <aside className="hub-side card">
        <TeamStandings players={players} teams={teams} />
        <Leaderboard players={players} title="Tonight" />
      </aside>
      <JoinBadge code={room.code} />
      {picked && (
        <StartGameModal
          game={picked}
          playerCount={players.length}
          onClose={() => setPicked(null)}
          onStart={(rounds) => {
            setPicked(null);
            void engine.startGame(picked.id, rounds);
          }}
        />
      )}
    </div>
  );
}

function StartGameModal({ game, playerCount, onClose, onStart }: { game: GameModule; playerCount: number; onClose: () => void; onStart: (rounds: number) => void }) {
  const [rounds, setRounds] = useState(game.defaultRoundsFor ? game.defaultRoundsFor(playerCount) : game.defaultRounds);
  return (
    <Modal onClose={onClose}>
      <h2>
        {game.emoji} {game.title}
      </h2>
      <p className="dim">{game.tagline}</p>
      <div className="row gap center rounds-picker">
        <button className="btn btn-lg" onClick={() => setRounds((r) => Math.max(1, r - 1))}>−</button>
        <div className="rounds-value">
          <span className="big-num">{rounds}</span>
          <span className="dim">round{rounds === 1 ? '' : 's'}</span>
        </div>
        <button className="btn btn-lg" onClick={() => setRounds((r) => Math.min(game.maxRounds, r + 1))}>+</button>
      </div>
      <div className="row gap end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-lg" autoFocus onClick={() => onStart(rounds)}>Start</button>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- intro
function Intro({ room, teams, openTeams }: Props) {
  const game = room.current_game ? GAMES[room.current_game] : undefined;
  if (!game) return null;
  return (
    <div className="screen center-stack intro">
      <div className="intro-emoji pop-in">{game.emoji}</div>
      <h1 className="display huge title-glow">{game.title}</h1>
      <p className="lead">{game.tagline}</p>
      <ol className="rules">
        {game.rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ol>
      {game.needsTeams && (
        <div className="center-stack">
          <button className="btn btn-lg" onClick={openTeams}>👥 Set up teams</button>
          <p className="dim">{teams.length >= 2 ? teams.map((t) => t.name).join(' vs ') : 'Two teams will be created when you start.'}</p>
        </div>
      )}
      <p className="dim">
        {room.rounds_total} round{room.rounds_total === 1 ? '' : 's'}
        {!game.scored && ' · no points'}
      </p>
      <p className="tv-footer">
        Host presses <kbd>Space</kbd> to begin
      </p>
      <JoinBadge code={room.code} />
    </div>
  );
}

// ----------------------------------------------------------------- play
function Play({ room, players, engine, engineSnap }: Props) {
  const game = room.current_game ? GAMES[room.current_game] : undefined;
  if (!game) return null;
  const Game = game.TV;
  const accepting = Boolean(room.state.accept && (room.state.accept.submit?.length || room.state.accept.vote?.length));
  const done = new Set(room.state.done ?? []);

  return (
    <div className="screen play">
      {Boolean(room.state.paused) && (
        <div className="pause-overlay">
          <div className="display huge">⏸ Paused</div>
          <p className="lead">Press <kbd>Space</kbd> or <kbd>P</kbd> to resume</p>
        </div>
      )}
      <header className="play-header">
        <div className="play-title">
          <span>{game.emoji}</span> {game.title}
        </div>
        <div className="play-round">
          {game.progressLabel ? (
            game.progressLabel(room)
          ) : (
            <>
              Round {room.round}
              <span className="dim"> / {room.rounds_total}</span>
            </>
          )}
        </div>
        <div className="play-timer">
          {!room.state.hideTimer && <Countdown endsAt={room.timer_ends_at} duration={room.timer_duration} size="lg" sound />}
        </div>
      </header>
      <main className="play-body">
        {room.state.step ? (
          <Game room={room} players={players} subs={engineSnap.subs} votes={engineSnap.votes} run={engineSnap.run} engine={engine} />
        ) : (
          <div className="center-stack"><div className="spinner" /></div>
        )}
      </main>
      {accepting && !room.state.hideStrip && players.length > 0 && (
        <footer className="waiting-strip">
          {players.map((p) => (
            <span key={p.id} className={done.has(p.id) ? 'is-done' : 'is-waiting'}>
              <Avatar player={p} size="md" dim={!done.has(p.id)} />
            </span>
          ))}
        </footer>
      )}
      <div className="join-badge join-badge-mini" title="Press Q for the QR code">{room.code} · Q</div>
    </div>
  );
}

// ----------------------------------------------------------------- results
function Results({ room, players, teams }: Props) {
  const game = room.current_game ? GAMES[room.current_game] : undefined;
  const standings = (room.state.standings as { playerId: string; points: number }[] | undefined) ?? [];
  const map = new Map(players.map((p) => [p.id, p]));
  return (
    <div className="screen results">
      <div className="results-main">
        <h1 className="display title-glow">
          {game?.emoji} {game?.title ?? 'Game'} results
        </h1>
        {game && !game.scored ? (
          <p className="lead">No points in this one. Everybody wins (nobody wins).</p>
        ) : (
          <ol className="standings">
            {standings.map((s, i) => {
              const p = map.get(s.playerId);
              if (!p) return null;
              return (
                <li key={s.playerId} className="pop-in" style={{ animationDelay: `${i * 90}ms` }}>
                  <span className="tap-place">{i + 1}</span>
                  <PlayerChip player={p} size="lg" />
                  <span className="points">+{s.points}</span>
                </li>
              );
            })}
          </ol>
        )}
        <p className="tv-footer">
          <kbd>Space</kbd> back to the hub
        </p>
      </div>
      <aside className="hub-side card">
        <TeamStandings players={players} teams={teams} />
        <Leaderboard players={players} title="Tonight" />
      </aside>
    </div>
  );
}

// ----------------------------------------------------------------- awards
function Awards({ room, players, teams }: Props) {
  const awards = (room.state.awards as Award[] | undefined) ?? [];
  const stage = Number(room.state.stage ?? 0);
  const map = new Map(players.map((p) => [p.id, p]));
  const ranked = [...players].sort((a, b) => b.score - a.score);

  if (stage === 0) {
    const [first, second, third] = ranked;
    const slots = [
      { p: second, place: 2 },
      { p: first, place: 1 },
      { p: third, place: 3 },
    ];
    return (
      <div className="screen center-stack">
        <h1 className="display huge title-glow">🏆 Final Standings</h1>
        <div className="podium">
          {slots.map(({ p, place }) =>
            p ? (
              <div key={place} className={`podium-col podium-${place} pop-in`} style={{ animationDelay: `${(3 - place) * 400}ms` }}>
                <PlayerChip player={p} size="xl" />
                <div className="podium-score">{p.score.toLocaleString()}</div>
                <div className="podium-block">{place}</div>
              </div>
            ) : (
              <div key={place} className="podium-col" />
            ),
          )}
        </div>
        {teamTotals(players, teams).length > 0 && (
          <p className="lead">
            🏅 Winning team: <b>{teamTotals(players, teams)[0].emoji} {teamTotals(players, teams)[0].name}</b>
          </p>
        )}
        <div className="podium-rest">
          {ranked.slice(3).map((p, i) => (
            <span key={p.id} className="dim">{i + 4}. {p.name} ({p.score})</span>
          ))}
        </div>
        <p className="tv-footer"><kbd>Space</kbd> for the awards</p>
      </div>
    );
  }

  if (stage > awards.length) return <RecapScreen code={room.code} />;
  const award = awards[stage - 1];
  if (!award) return null;
  return (
    <div className="screen center-stack award-screen">
      <div className="intro-emoji pop-in">{award.emoji}</div>
      <h1 className="display huge title-glow">{award.title}</h1>
      <div className="row gap center wrap pop-in">
        {award.playerIds.map((id) => {
          const p = map.get(id);
          return p ? <PlayerChip key={id} player={p} size="xl" /> : null;
        })}
      </div>
      <p className="lead">{award.detail}</p>
      <p className="tv-footer"><kbd>Space</kbd> {stage < awards.length ? 'next award' : 'back to the hub'}</p>
    </div>
  );
}

function RecapScreen({ code }: { code: string }) {
  const url = `${window.location.origin}/recap?code=${code}`;
  return (
    <div className="screen center-stack">
      <h1 className="display huge title-glow">📸 Night Recap</h1>
      <p className="lead">Scan to get the scoreboard, awards and best moments. Save it, share it!</p>
      <div className="qr" style={{ maxWidth: '20em' }}>
        <QRCodeSVG value={url} size={512} marginSize={2} bgColor="#ffffff" fgColor="#000000" />
      </div>
      <p className="tv-footer"><kbd>Space</kbd> back to the hub</p>
    </div>
  );
}
