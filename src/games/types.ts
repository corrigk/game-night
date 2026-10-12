import type { ComponentType } from 'react';
import type { GameRun, Player, Room, Submission, Team, Vote } from '../lib/types';
import type { HostEngine } from '../tv/engine';

/**
 * A game is a self-contained module. The engine owns the shared lifecycle
 * (intro → rounds → results → hub); the module only defines what happens inside
 * a round. All game data lives in generic tables (game_runs.config/state,
 * submissions.payload, rooms.state) so adding a game needs no schema change.
 */
export interface GameModule {
  id: string;
  title: string;
  emoji: string;
  tagline: string;
  /** Shown on the intro screen (TV) and phones. Keep each line short. */
  rules: string[];
  /** Story Chain is the only unscored game. */
  scored: boolean;
  defaultRounds: number;
  maxRounds: number;
  /** 'soon' tiles show on the hub but can't be started yet. */
  status: 'ready' | 'soon';
  soonNote?: string;

  /** Optional per-run setup (pick a deck, etc.), stored in game_runs.state. */
  setup?(ctx: GameCtx): Promise<void>;
  /** Called at the start of every round (ctx.room.round is already set). */
  startRound(ctx: GameCtx): Promise<void>;
  /** Host pressed Next / Space during play. */
  next(ctx: GameCtx): Promise<void>;
  /** Step timer hit zero. Defaults to next(). */
  onTimerEnd?(ctx: GameCtx): Promise<void>;
  /**
   * Checked ~2x/second while playing. Return true when the current step should
   * advance on its own (e.g. everyone has answered); the engine then calls next()
   * once for that step. Must be synchronous and side-effect free.
   */
  ready?(ctx: GameCtx): boolean;
  /** Host pressed Skip. Defaults to: wipe this round's input and restart it. */
  skip?(ctx: GameCtx): Promise<void>;
  /**
   * Runs (serialized) whenever this round's submissions change. Use it to validate
   * input, e.g. delete a bad submission and publish a rejection. Must be idempotent.
   */
  process?(ctx: GameCtx): Promise<void>;
  /** Host-only buttons rendered by the TV component (engine.gameAction). */
  action?(ctx: GameCtx, name: string, payload: Record<string, unknown>): Promise<void>;

  /** Needs 2+ teams: the engine creates 2 at game start if there are none. */
  needsTeams?: boolean;
  /** Default round count that depends on the room (e.g. Dolphin: one per player, up to 6). */
  defaultRoundsFor?(playerCount: number): number;
  /** Engine rounds that make one host-visible round (Hot Seat: one turn per team). */
  turnsPerRound?(teamCount: number): number;
  /** Header text, when "Round 3 / 8" is not the right framing. */
  progressLabel?(room: Room): string;
  /** Called once when the game ends, naturally or early, before results are tallied. */
  onFinish?(ctx: GameCtx): Promise<void>;
  /** Extra controls in the host drawer while this game runs. */
  HostControls?: ComponentType<HostControlsProps>;

  TV: ComponentType<TVGameProps>;
  Phone: ComponentType<PhoneGameProps>;
}

export interface HostControlsProps {
  room: Room;
  players: Player[];
  run: GameRun | null;
  engine: HostEngine;
}

export interface TVGameProps {
  room: Room;
  players: Player[];
  /** Everything submitted in this run (all rounds). TV only; phones never get this. */
  subs: Submission[];
  votes: Vote[];
  /** The current run, including engine-private state (host-only: never forward it to phones). */
  run: GameRun | null;
  engine: HostEngine;
}

export interface PhoneGameProps {
  room: Room;
  me: Player;
  players: Player[];
  api: PhoneApi;
}

export interface PhoneApi {
  submit(kind: string, payload: Record<string, unknown>): Promise<void>;
  vote(kind: string, target: { submissionId?: string; playerId?: string }): Promise<void>;
  /** My own submissions/votes for the current run + round (RLS-limited to me). */
  mySubs: Submission[];
  myVotes: Vote[];
}

export interface StepOptions {
  /** Start a countdown for this step. */
  seconds?: number;
  /** Submission kinds phones may send during this step. */
  submit?: string[];
  /** Vote kinds phones may send during this step. */
  vote?: string[];
  /** Which input drives the "who's done" strip. Defaults to submit if any, else vote. */
  track?: 'submit' | 'vote';
  /** Submission kinds that count toward "done" (default: all of `submit`). */
  count?: string[];
}

export interface NewSub {
  kind: string;
  player_id: string | null;
  payload: Record<string, unknown>;
  /** Defaults to the current round. */
  round?: number;
}

/** What a module's engine hooks get. Getters always return the latest data. */
export interface GameCtx {
  readonly room: Room;
  readonly players: Player[];
  readonly teams: Team[];
  readonly run: GameRun;
  /** This round's submissions / votes, optionally filtered by kind. */
  roundSubs(kind?: string): Submission[];
  roundVotes(kind?: string): Vote[];
  /** Everything from this run, any round. */
  allSubs(kind?: string): Submission[];
  allVotes(): Vote[];
  /** Host-side inserts (private per-player rows like hands, system rows like the real answer). */
  addSubs(rows: NewSub[]): Promise<Submission[]>;
  removeSubs(ids: string[]): Promise<void>;
  /** Replace the public step state (and timer / accepted input). */
  setStep(step: string, data?: Record<string, unknown>, opts?: StepOptions): Promise<void>;
  /** Merge into the public step state without touching timer/accept. */
  patchState(data: Record<string, unknown>): Promise<void>;
  /** Merge into engine-private run state (never visible to phones). */
  saveRun(state: Record<string, unknown>): Promise<void>;
  award(events: { playerId: string; points: number; reason: string }[]): Promise<void>;
  /** End the whole game now and show results (points are kept). */
  endGame(): Promise<void>;
  /** Finish this round: next round, or results after the last one. */
  endRound(): Promise<void>;
}
