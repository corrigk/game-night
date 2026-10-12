import { useEffect, useState } from 'react';
import { TEAMS } from '../config';
import { PlayerChip } from '../components/PlayerChip';
import { teamEmoji } from '../lib/teams';
import type { Player, Team } from '../lib/types';
import type { HostEngine } from './engine';

/**
 * Full-screen team setup (hub, host drawer, or the `T` key): pick 2-4 teams, re-roll the random
 * balanced split, rename teams, or click a player to move them to the next team.
 */
export function TeamSetup({ teams, players, engine, onClose }: { teams: Team[]; players: Player[]; engine: HostEngine; onClose: () => void }) {
  const on = teams.length > 0;
  const unassigned = players.filter((p) => !p.team_id || !teams.some((t) => t.id === p.team_id));

  return (
    <div className="team-setup" role="dialog" aria-label="Team setup">
      <div className="team-setup-head">
        <h1 className="display">👥 Teams</h1>
        <div className="row gap wrap">
          {Array.from({ length: TEAMS.maxCount - 1 }, (_, i) => i + 2).map((n) => (
            <button key={n} className={`btn btn-lg${teams.length === n ? ' btn-primary' : ''}`} onClick={() => void engine.setTeamCount(n)}>
              {n} teams
            </button>
          ))}
          {on && <button className="btn btn-lg" onClick={() => void engine.rerollTeams()}>🎲 Re-roll</button>}
          {on && <button className="btn btn-lg btn-danger" onClick={() => void engine.clearTeams()}>Teams off</button>}
          <button className="btn btn-lg btn-primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>

      {!on ? (
        <div className="center-stack grow">
          <p className="lead">Teams are off. Pick a number of teams above to deal everyone in at random.</p>
          <p className="dim">{players.length} player{players.length === 1 ? '' : 's'} in the room · {TEAMS.defaultCount} teams is the usual</p>
        </div>
      ) : (
        <>
          <p className="dim">
            Click a player to move them to the next team. Teams stay for the whole night; late joiners land on the smallest team.
          </p>
          <div className="team-cols">
            {teams.map((t, i) => {
              const members = players.filter((p) => p.team_id === t.id);
              const next = teams[(i + 1) % teams.length];
              return (
                <div key={t.id} className="team-col" style={{ ['--tc' as string]: t.color }}>
                  <TeamName team={t} index={i} engine={engine} />
                  <div className="team-count">{members.length} player{members.length === 1 ? '' : 's'}</div>
                  <div className="team-members">
                    {members.map((p) => (
                      <button key={p.id} className="team-member" onClick={() => void engine.movePlayer(p.id, next.id)} title={`Move to ${next.name}`}>
                        <PlayerChip player={p} size="lg" />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {unassigned.length > 0 && (
            <div className="team-col" style={{ ['--tc' as string]: 'var(--border)' }}>
              <div className="team-count">No team yet</div>
              <div className="team-members">
                {unassigned.map((p) => (
                  <button key={p.id} className="team-member" onClick={() => void engine.movePlayer(p.id, teams[0].id)}>
                    <PlayerChip player={p} size="lg" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TeamName({ team, index, engine }: { team: Team; index: number; engine: HostEngine }) {
  const [name, setName] = useState(team.name);
  useEffect(() => setName(team.name), [team.name]);
  const commit = () => {
    const clean = name.trim().slice(0, 30);
    if (!clean) return setName(team.name);
    if (clean !== team.name) void engine.renameTeam(team.id, clean);
  };
  return (
    <div className="row gap">
      <span className="lead">{teamEmoji(index)}</span>
      <input
        className="input"
        value={name}
        maxLength={30}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Team name"
      />
    </div>
  );
}
