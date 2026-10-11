import type { ComponentType } from 'react';
import type { GameRun, Player, Room, Submission, Vote } from '../lib/types';
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

  TV: ComponentType<TVGameProps>;
  Phone: ComponentType<PhoneGameProps>;
}

export interface TVGameProps {
  room: Room;
  players: Player[];
  /** Everything submitted in this run (all rounds). TV only; phones never get this. */
  subs: Submission[];
  votes: Vote[];
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
}

/** What a module's engine hooks get. Getters always return the latest data. */
export interface GameCtx {
  readonly room: Room;
  readonly players: Player[];
  readonly run: GameRun;
  /** This round's submissions / votes, optionally filtered by kind. */
  roundSubs(kind?: string): Submission[];
  roundVotes(kind?: string): Vote[];
  /** Replace the public step state (and timer / accepted input). */
  setStep(step: string, data?: Record<string, unknown>, opts?: StepOptions): Promise<void>;
  /** Merge into the public step state without touching timer/accept. */
  patchState(data: Record<string, unknown>): Promise<void>;
  /** Merge into engine-private run state (never visible to phones). */
  saveRun(state: Record<string, unknown>): Promise<void>;
  award(events: { playerId: string; points: number; reason: string }[]): Promise<void>;
  /** Finish this round: next round, or results after the last one. */
  endRound(): Promise<void>;
}
