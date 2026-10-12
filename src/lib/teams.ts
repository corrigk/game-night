import { shuffle } from './random';
import type { Player, RoomSettings } from './types';

export interface TeamDef {
  name: string;
  emoji: string;
  color: string;
}

export const TEAM_DEFS: TeamDef[] = [
  { name: 'Red Rockets', emoji: '🚀', color: '#e53935' },
  { name: 'Blue Bananas', emoji: '🍌', color: '#1e88e5' },
  { name: 'Green Goblins', emoji: '👺', color: '#43a047' },
  { name: 'Gold Geese', emoji: '🪿', color: '#ffc107' },
];

export interface TeamsSettings {
  enabled: boolean;
  count: number;
  assign: Record<string, number>;
}

export function teamsOf(settings: RoomSettings | undefined): TeamsSettings | null {
  const t = settings?.teams as TeamsSettings | undefined;
  return t && t.enabled ? t : null;
}

export function teamOf(settings: RoomSettings | undefined, playerId: string): (TeamDef & { index: number }) | null {
  const t = teamsOf(settings);
  const i = t?.assign[playerId];
  return t && i != null && TEAM_DEFS[i] && i < t.count ? { ...TEAM_DEFS[i], index: i } : null;
}

export interface TeamTotal extends TeamDef {
  index: number;
  total: number;
  members: Player[];
}

/** Team standings: a team's score is the sum of its members' scores. Best first. */
export function teamTotals(players: Player[], settings: RoomSettings | undefined): TeamTotal[] {
  const t = teamsOf(settings);
  if (!t) return [];
  return Array.from({ length: t.count }, (_, index) => {
    const members = players.filter((p) => t.assign[p.id] === index);
    return { ...TEAM_DEFS[index], index, members, total: members.reduce((s, p) => s + p.score, 0) };
  }).sort((a, b) => b.total - a.total);
}

/** Deal everyone onto `count` teams as evenly as possible. */
export function balancedAssign(players: Player[], count: number): Record<string, number> {
  const out: Record<string, number> = {};
  shuffle(players).forEach((p, i) => {
    out[p.id] = i % count;
  });
  return out;
}

/** Put players who have no team (late joiners) on the smallest team. Returns null if nothing changed. */
export function assignNewcomers(players: Player[], t: TeamsSettings): Record<string, number> | null {
  const assign: Record<string, number> = {};
  for (const p of players) if (t.assign[p.id] != null && t.assign[p.id] < t.count) assign[p.id] = t.assign[p.id];
  const sizes = Array.from({ length: t.count }, (_, i) => Object.values(assign).filter((v) => v === i).length);
  let changed = false;
  for (const p of players) {
    if (assign[p.id] != null) continue;
    const smallest = sizes.indexOf(Math.min(...sizes));
    assign[p.id] = smallest;
    sizes[smallest]++;
    changed = true;
  }
  return changed ? assign : null;
}
