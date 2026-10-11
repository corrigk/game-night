export type Phase = 'lobby' | 'hub' | 'intro' | 'play' | 'results' | 'awards';

export type ThemeId = 'neon' | 'arcade' | 'cartoon' | 'glass' | 'dark';

export interface RoomSettings {
  theme?: ThemeId;
  roster?: string[];
  maxPlayers?: number;
  [key: string]: unknown;
}

/** Public, phone-visible state for the current step. Never put secrets here. */
export interface RoomState {
  step?: string;
  accept?: { submit?: string[]; vote?: string[] };
  /** Player ids that have submitted / voted this step (for "waiting on…" UI). */
  done?: string[];
  [key: string]: unknown;
}

export interface Room {
  id: string;
  code: string;
  host_uid: string;
  phase: Phase;
  current_game: string | null;
  current_run_id: string | null;
  round: number;
  rounds_total: number;
  state: RoomState;
  timer_ends_at: string | null;
  timer_duration: number | null;
  settings: RoomSettings;
  created_at: string;
  updated_at: string;
}

export interface Player {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  emoji: string;
  color: string;
  score: number;
  connected: boolean;
  joined_at: string;
}

export type RunStatus = 'intro' | 'playing' | 'results' | 'done' | 'exited';

export interface GameRun {
  id: string;
  room_id: string;
  game_type: string;
  status: RunStatus;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  created_at: string;
  ended_at: string | null;
}

export interface Submission {
  id: string;
  room_id: string;
  run_id: string;
  round: number;
  kind: string;
  player_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Vote {
  id: string;
  room_id: string;
  run_id: string;
  round: number;
  kind: string;
  voter_id: string;
  target_submission_id: string | null;
  target_player_id: string | null;
  created_at: string;
}

export interface ScoreEvent {
  id: string;
  room_id: string;
  player_id: string;
  run_id: string | null;
  points: number;
  reason: string;
  created_at: string;
}
