import { TEAMS } from '../config';
import { shuffle } from './random';
import type { Player, Team } from './types';

export const teamEmoji = (index: number) => TEAMS.emojis[index % TEAMS.emojis.length];

export type TeamInfo = Team & { index: number; emoji: string };

/** The team a player is on (or null). `teams` must be in stable order (sortTeams). */
export function teamOf(teams: Team[], player: Pick<Player, 'team_id'> | null | undefined): TeamInfo | null {
  if (!player?.team_id) return null;
  const index = teams.findIndex((t) => t.id === player.team_id);
  return index < 0 ? null : { ...teams[index], index, emoji: teamEmoji(index) };
}

export interface TeamTotal extends TeamInfo {
  total: number;
  members: Player[];
}

/** Team standings: a team's night total is the sum of its members' cumulative scores. Best first. */
export function teamTotals(players: Player[], teams: Team[]): TeamTotal[] {
  return teams
    .map((t, index) => {
      const members = players.filter((p) => p.team_id === t.id);
      return { ...t, index, emoji: teamEmoji(index), members, total: members.reduce((s, p) => s + p.score, 0) };
    })
    .sort((a, b) => b.total - a.total || a.index - b.index);
}

/** Deal players onto teams as evenly as possible (odd counts: the first teams get one extra). */
export function balancedAssign(players: Player[], teams: Team[]): Record<string, string> {
  const out: Record<string, string> = {};
  shuffle(players).forEach((p, i) => {
    out[p.id] = teams[i % teams.length].id;
  });
  return out;
}

/** First default name / color not already used by a team in this room. */
export function nextTeamLook(teams: Team[]): { name: string; color: string } {
  const names = new Set(teams.map((t) => t.name));
  const colors = new Set(teams.map((t) => t.color.toLowerCase()));
  const name = TEAMS.names.find((n) => !names.has(n)) ?? `Team ${teams.length + 1}`;
  const color = TEAMS.colors.find((c) => !colors.has(c.toLowerCase())) ?? TEAMS.colors[teams.length % TEAMS.colors.length];
  return { name, color };
}

/** Team a late joiner should land on: the smallest. */
export function smallestTeam(players: Player[], teams: Team[]): Team {
  const size = (t: Team) => players.filter((p) => p.team_id === t.id).length;
  return teams.reduce((best, t) => (size(t) < size(best) ? t : best), teams[0]);
}
