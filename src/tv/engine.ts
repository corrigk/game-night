import { useSyncExternalStore } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { GAMES } from '../games/registry';
import type { GameCtx, GameModule, NewSub, StepOptions } from '../games/types';
import { serverNow } from '../lib/clock';
import type { RoomStore } from '../lib/roomStore';
import { errorCode, supabase } from '../lib/supabase';
import type { GameRun, Player, Room, RoomSettings, Submission, Team, Vote } from '../lib/types';
import { computeNight } from './awards';
import { TEAMS } from '../config';
import { balancedAssign, nextTeamLook, smallestTeam } from '../lib/teams';

export interface RunSummary {
  id: string;
  game_type: string;
  status: GameRun['status'];
}

export interface EngineSnapshot {
  run: GameRun | null;
  runs: RunSummary[];
  subs: Submission[];
  votes: Vote[];
  error: string | null;
}

const CLEAR_TIMER = { timer_ends_at: null, timer_duration: null } as const;

/**
 * The game engine. Runs only on the TV page, which is the single source of truth:
 * it writes rooms.phase/round/state/timers, reads every submission and vote, and
 * awards points. Everything it needs is re-derivable from the database, so a TV
 * refresh resumes exactly where it left off.
 */
export class HostEngine {
  private snap: EngineSnapshot = { run: null, runs: [], subs: [], votes: [], error: null };
  private listeners = new Set<() => void>();
  private channel: RealtimeChannel | null = null;
  private interval: number | undefined;
  private unsubStore: (() => void) | null = null;
  private loadedRunId: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private pendingKeys = new Map<string, number>();
  private pending = 0;
  private lastPoll = 0;
  private autoFiredFor: string | null = null;
  private lastProcessSig = '';

  constructor(readonly store: RoomStore) {}

  // ---------------------------------------------------------------- store plumbing
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<EngineSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  start() {
    const room = this.store.getSnapshot().room;
    if (!room) return;
    this.unsubStore = this.store.subscribe(() => this.onStoreChange());
    this.listen(room.id);
    void this.loadRuns();
    this.onStoreChange();
    this.interval = window.setInterval(() => this.tick(), 400);
  }

  stop() {
    window.clearInterval(this.interval);
    this.unsubStore?.();
    if (this.channel) void supabase.removeChannel(this.channel);
    this.listeners.clear();
  }

  get room(): Room {
    const room = this.store.getSnapshot().room;
    if (!room) throw new Error('Room not loaded');
    return room;
  }

  get players(): Player[] {
    return this.store.getSnapshot().players;
  }

  get module(): GameModule | undefined {
    const id = this.store.getSnapshot().room?.current_game;
    return id ? GAMES[id] : undefined;
  }

  clearError = () => this.set({ error: null });

  private onStoreChange() {
    const runId = this.store.getSnapshot().room?.current_run_id ?? null;
    if (runId !== this.loadedRunId) {
      this.loadedRunId = runId;
      void this.loadRun(runId);
    }
  }

  private async loadRun(runId: string | null) {
    if (!runId) {
      this.set({ run: null, subs: [], votes: [] });
      return;
    }
    const [run, subs, votes] = await Promise.all([
      supabase.from('game_runs').select('*').eq('id', runId).single(),
      supabase.from('submissions').select('*').eq('run_id', runId).order('created_at'),
      supabase.from('votes').select('*').eq('run_id', runId).order('created_at'),
    ]);
    if (this.loadedRunId !== runId) return;
    if (run.error) return this.set({ error: run.error.message });
    this.set({
      run: run.data as GameRun,
      subs: (subs.data ?? []) as Submission[],
      votes: (votes.data ?? []) as Vote[],
    });
  }

  async loadRuns() {
    const room = this.store.getSnapshot().room;
    if (!room) return;
    const { data } = await supabase
      .from('game_runs')
      .select('id, game_type, status')
      .eq('room_id', room.id)
      .order('created_at');
    this.set({ runs: (data ?? []) as RunSummary[] });
  }

  private listen(roomId: string) {
    const upsert = <T extends { id: string; run_id: string }>(list: T[], row: T): T[] | null => {
      if (row.run_id !== this.loadedRunId) return null;
      return [...list.filter((x) => x.id !== row.id), row];
    };
    const remove = <T extends { id: string }>(list: T[], id: string) => list.filter((x) => x.id !== id);

    this.channel = supabase
      .channel(`engine:${roomId}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions', filter: `room_id=eq.${roomId}` }, (p) => {
        if (p.eventType === 'DELETE') return this.set({ subs: remove(this.snap.subs, (p.old as Submission).id) });
        const next = upsert(this.snap.subs, p.new as Submission);
        if (next) this.set({ subs: next });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes', filter: `room_id=eq.${roomId}` }, (p) => {
        if (p.eventType === 'DELETE') return this.set({ votes: remove(this.snap.votes, (p.old as Vote).id) });
        const next = upsert(this.snap.votes, p.new as Vote);
        if (next) this.set({ votes: next });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'submissions' }, (p) => {
        this.set({ subs: remove(this.snap.subs, (p.old as Submission).id) });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'votes' }, (p) => {
        this.set({ votes: remove(this.snap.votes, (p.old as Vote).id) });
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void this.loadRun(this.loadedRunId);
      });
  }

  // ---------------------------------------------------------------- persistence
  async patchRoom(patch: Partial<Room>): Promise<Room> {
    const { data, error } = await supabase.from('rooms').update(patch).eq('id', this.room.id).select().single();
    if (error) throw error;
    this.store.applyRoom(data as Room);
    return data as Room;
  }

  private async patchRun(patch: Partial<GameRun>) {
    const run = this.snap.run;
    if (!run) return;
    const { data, error } = await supabase.from('game_runs').update(patch).eq('id', run.id).select().single();
    if (error) throw error;
    if (this.loadedRunId === run.id) this.set({ run: data as GameRun });
  }

  /**
   * Serialize every state change. Actions sharing a `key` are de-duplicated: a
   * second "advance" while one is in flight is dropped, so mashing Space (or the
   * timer expiring as the host presses Next) can never skip a step.
   */
  private act(fn: () => Promise<void>, key?: string): Promise<void> {
    if (key && this.pendingKeys.get(key)) return Promise.resolve();
    if (key) this.pendingKeys.set(key, (this.pendingKeys.get(key) ?? 0) + 1);
    this.pending++;
    const p = this.chain
      .then(fn)
      .catch((e) => {
        console.error(e);
        this.set({ error: errorCode(e) });
      })
      .finally(() => {
        this.pending--;
        if (key) this.pendingKeys.set(key, (this.pendingKeys.get(key) ?? 1) - 1);
      });
    this.chain = p;
    return p;
  }

  private ctx(): GameCtx {
    const self = this;
    const run = this.snap.run;
    if (!run) throw new Error('No active game run');
    const inRound = <T extends { round: number; kind: string }>(list: T[], kind?: string) =>
      list.filter((x) => x.round === self.room.round && (!kind || x.kind === kind));
    return {
      get room() {
        return self.room;
      },
      get players() {
        return self.players;
      },
      get run() {
        return self.snap.run ?? run;
      },
      roundSubs: (kind) => inRound(self.snap.subs, kind),
      roundVotes: (kind) => inRound(self.snap.votes, kind),
      allSubs: (kind) => self.snap.subs.filter((s) => !kind || s.kind === kind),
      allVotes: () => self.snap.votes,
      addSubs: (rows) => self.addSubs(rows),
      removeSubs: (ids) => self.removeSubs(ids),
      setStep: (step, data, opts) => self.setStep(step, data ?? {}, opts ?? {}),
      patchState: async (data) => {
        await self.patchRoom({ state: { ...self.room.state, ...data } });
      },
      saveRun: async (state) => {
        await self.patchRun({ state: { ...(self.snap.run?.state ?? {}), ...state } });
      },
      award: (events) => self.award(events),
      endRound: () => self.endRound(),
    };
  }

  private async addSubs(rows: NewSub[]): Promise<Submission[]> {
    const run = this.snap.run;
    if (!run || !rows.length) return [];
    const payload = rows.map((r) => ({
      room_id: this.room.id,
      run_id: run.id,
      round: r.round ?? this.room.round,
      kind: r.kind,
      player_id: r.player_id,
      payload: r.payload,
    }));
    const { data, error } = await supabase.from('submissions').insert(payload).select();
    if (error) throw error;
    const added = (data ?? []) as Submission[];
    const ids = new Set(added.map((s) => s.id));
    this.set({ subs: [...this.snap.subs.filter((s) => !ids.has(s.id)), ...added] });
    return added;
  }

  private async removeSubs(ids: string[]) {
    if (!ids.length) return;
    const { error } = await supabase.from('submissions').delete().in('id', ids);
    if (error) throw error;
    const gone = new Set(ids);
    this.set({ subs: this.snap.subs.filter((s) => !gone.has(s.id)) });
  }

  private async setStep(step: string, data: Record<string, unknown>, opts: StepOptions) {
    const accept =
      opts.submit || opts.vote
        ? {
            submit: opts.submit ?? [],
            vote: opts.vote ?? [],
            track: opts.track ?? (opts.submit?.length ? 'submit' : 'vote'),
            ...(opts.count ? { count: opts.count } : {}),
          }
        : undefined;
    await this.patchRoom({
      state: { ...data, step, stepAt: serverNow(), done: [], ...(accept ? { accept } : {}) },
      timer_ends_at: opts.seconds ? new Date(serverNow() + opts.seconds * 1000).toISOString() : null,
      // timer_duration is an integer column
      timer_duration: opts.seconds ? Math.ceil(opts.seconds) : null,
    });
  }

  private async award(events: { playerId: string; points: number; reason: string }[]) {
    const run = this.snap.run;
    const rows = events
      .filter((e) => e.points !== 0)
      .map((e) => ({ room_id: this.room.id, player_id: e.playerId, run_id: run?.id ?? null, points: e.points, reason: e.reason }));
    if (!rows.length) return;
    const { error } = await supabase.from('score_events').insert(rows);
    if (error) throw error;
  }

  private async beginRound(round: number) {
    const mod = this.module;
    if (!mod) return;
    this.autoFiredFor = null;
    await this.patchRoom({ phase: 'play', round, state: {}, ...CLEAR_TIMER });
    await mod.startRound(this.ctx());
  }

  private async endRound() {
    const r = this.room;
    if (r.round < r.rounds_total) await this.beginRound(r.round + 1);
    else await this.showResults();
  }

  private async showResults() {
    const run = this.snap.run;
    const totals: Record<string, number> = {};
    if (run) {
      const { data } = await supabase.from('score_events').select('player_id, points').eq('run_id', run.id);
      for (const e of data ?? []) totals[e.player_id] = (totals[e.player_id] ?? 0) + e.points;
      await this.patchRun({ status: 'done', ended_at: new Date().toISOString() });
    }
    const standings = this.players
      .map((p) => ({ playerId: p.id, points: totals[p.id] ?? 0 }))
      .sort((a, b) => b.points - a.points);
    await this.patchRoom({ phase: 'results', state: { standings }, ...CLEAR_TIMER });
    await this.loadRuns();
  }

  private async goHub() {
    const run = this.snap.run;
    if (run && run.status !== 'done' && run.status !== 'exited') {
      await this.patchRun({ status: 'exited', ended_at: new Date().toISOString() });
    }
    await this.patchRoom({
      phase: 'hub', current_game: null, current_run_id: null, round: 0, rounds_total: 0, state: {}, ...CLEAR_TIMER,
    });
    await this.loadRuns();
  }

  // ---------------------------------------------------------------- host actions
  startGame = (gameId: string, rounds: number) =>
    this.act(async () => {
      const mod = GAMES[gameId];
      if (!mod || mod.status !== 'ready') return;
      const prev = this.snap.run;
      if (prev && prev.status !== 'done' && prev.status !== 'exited') {
        await this.patchRun({ status: 'exited', ended_at: new Date().toISOString() });
      }
      const { data, error } = await supabase
        .from('game_runs')
        .insert({ room_id: this.room.id, game_type: gameId, status: 'intro', config: { rounds } })
        .select()
        .single();
      if (error) throw error;
      const run = data as GameRun;
      this.loadedRunId = run.id;
      this.set({ run, subs: [], votes: [] });
      await this.patchRoom({
        phase: 'intro', current_game: gameId, current_run_id: run.id, round: 0, rounds_total: rounds, state: {}, ...CLEAR_TIMER,
      });
      if (mod.setup) await mod.setup(this.ctx());
      await this.loadRuns();
    }, 'advance');

  next = () =>
    this.act(async () => {
      const room = this.room;
      if (room.state.paused) return void (await this.resumeInline());
      switch (room.phase) {
        case 'lobby':
          await this.patchRoom({ phase: 'hub' });
          break;
        case 'intro':
          await this.patchRun({ status: 'playing' });
          await this.beginRound(1);
          break;
        case 'play':
          if (this.module) await this.module.next(this.ctx());
          break;
        case 'results':
          await this.goHub();
          break;
        case 'awards': {
          const st = this.room.state;
          const total = ((st.awards as unknown[] | undefined) ?? []).length + 1; // +1: the recap QR
          const stage = Number(st.stage ?? 0);
          if (stage < total) await this.patchRoom({ state: { ...st, stage: stage + 1 } });
          else await this.goHub();
          break;
        }
        case 'hub':
          break;
      }
    }, 'advance');

  skip = () => this.act(() => this.skipInline(), 'advance');

  /** Retire the current prompt/photo/talent for good, then skip to a fresh one. */
  vetoSkip = () =>
    this.act(async () => {
      const cur = this.snap.run?.state.cur as { table: string; id: string } | null | undefined;
      if (cur) {
        const { error } = await supabase.from(cur.table).update({ vetoed: true }).eq('id', cur.id);
        if (error) throw error;
      }
      await this.skipInline();
    }, 'advance');

  togglePause = () =>
    this.act(async () => {
      const r = this.room;
      if (r.state.paused) return this.resumeInline();
      if (r.phase !== 'play') return;
      const left = r.timer_ends_at ? Math.max(0, Date.parse(r.timer_ends_at) - serverNow()) : 0;
      await this.patchRoom({
        state: { ...r.state, paused: true, pausedLeft: left, pausedAccept: r.state.accept ?? null, accept: undefined },
        timer_ends_at: null,
      });
    });

  private async resumeInline() {
    const r = this.room;
    const { paused: _p, pausedLeft, pausedAccept, ...rest } = r.state as Record<string, unknown>;
    void _p;
    const left = Number(pausedLeft ?? 0);
    await this.patchRoom({
      state: { ...rest, ...(pausedAccept ? { accept: pausedAccept } : {}) } as Room['state'],
      timer_ends_at: left > 0 ? new Date(serverNow() + left).toISOString() : null,
    });
  }

  private skipInline = async () => {
      const room = this.room;
      const mod = this.module;
      if (room.phase !== 'play' || !mod) return void (await this.nextInline());
      if (mod.skip) return void (await mod.skip(this.ctx()));
      // Default: throw away this round's input and deal a fresh prompt.
      const run = this.snap.run;
      if (run) {
        await supabase.from('votes').delete().eq('run_id', run.id).eq('round', room.round);
        await supabase.from('submissions').delete().eq('run_id', run.id).eq('round', room.round);
        this.set({
          subs: this.snap.subs.filter((s) => s.round !== room.round),
          votes: this.snap.votes.filter((v) => v.round !== room.round),
        });
      }
      await this.beginRound(room.round);
  };

  /** Next, for use inside an action that already holds the queue. */
  private async nextInline() {
    const room = this.room;
    if (room.phase === 'intro') {
      await this.patchRun({ status: 'playing' });
      await this.beginRound(1);
    } else if (room.phase === 'results' || room.phase === 'awards') {
      await this.goHub();
    } else if (room.phase === 'lobby') {
      await this.patchRoom({ phase: 'hub' });
    }
  }

  addTime = (seconds = 15) =>
    this.act(async () => {
      const r = this.room;
      if (r.state.paused) {
        await this.patchRoom({ state: { ...r.state, pausedLeft: Number(r.state.pausedLeft ?? 0) + seconds * 1000 } });
        return;
      }
      if (!r.timer_ends_at) return;
      const base = Math.max(Date.parse(r.timer_ends_at), serverNow());
      await this.patchRoom({
        timer_ends_at: new Date(base + seconds * 1000).toISOString(),
        timer_duration: (r.timer_duration ?? 0) + seconds,
      });
    });

  addRound = () =>
    this.act(async () => {
      const r = this.room;
      if (r.phase !== 'intro' && r.phase !== 'play') return;
      const rounds = Math.min(r.rounds_total + 1, 50);
      await this.patchRoom({ rounds_total: rounds });
      await this.patchRun({ config: { ...(this.snap.run?.config ?? {}), rounds } });
    });

  endGameEarly = () =>
    this.act(async () => {
      const r = this.room;
      if (r.phase === 'intro' || r.phase === 'play') await this.showResults();
    }, 'advance');

  backToHub = () => this.act(() => this.goHub(), 'advance');

  // ---------------------------------------------------------------- teams
  private get teams(): Team[] {
    return this.store.getSnapshot().teams;
  }

  private async setPlayerTeam(playerId: string, teamId: string | null) {
    const { data, error } = await supabase.from('players').update({ team_id: teamId }).eq('id', playerId).select().single();
    if (error) throw error;
    this.store.applyPlayer(data as Player);
  }

  /** Randomly deal everyone onto the given teams, as evenly as possible. */
  private async dealTeams(teams: Team[]) {
    if (!teams.length) return;
    const assign = balancedAssign(this.players, teams);
    await Promise.all(this.players.map((p) => this.setPlayerTeam(p.id, assign[p.id])));
  }

  /** Create or trim teams to `count` (2-4) and re-deal everyone. Existing teams keep their names. */
  setTeamCount = (count: number) =>
    this.act(async () => {
      const n = Math.max(2, Math.min(TEAMS.maxCount, Math.round(count)));
      let teams = [...this.teams];
      if (teams.length > n) {
        const { error } = await supabase.from('teams').delete().in('id', teams.slice(n).map((t) => t.id));
        if (error) throw error;
        teams = teams.slice(0, n);
      }
      while (teams.length < n) {
        const { data, error } = await supabase.from('teams').insert({ room_id: this.room.id, ...nextTeamLook(teams) }).select().single();
        if (error) throw error;
        teams.push(data as Team);
      }
      this.store.applyTeams(teams);
      await this.dealTeams(this.teams);
    });

  rerollTeams = () => this.act(() => this.dealTeams(this.teams));

  movePlayer = (playerId: string, teamId: string | null) => this.act(() => this.setPlayerTeam(playerId, teamId));

  renameTeam = (teamId: string, name: string) =>
    this.act(async () => {
      const clean = name.trim().slice(0, 30);
      if (!clean) return;
      const { data, error } = await supabase.from('teams').update({ name: clean }).eq('id', teamId).select().single();
      if (error) throw error;
      this.store.applyTeams(this.teams.map((t) => (t.id === teamId ? (data as Team) : t)));
    });

  clearTeams = () =>
    this.act(async () => {
      const { error } = await supabase.from('teams').delete().eq('room_id', this.room.id);
      if (error) throw error;
      this.store.applyTeams([]);
      for (const p of this.players) this.store.applyPlayer({ ...p, team_id: null });
    });

  /** Late joiners (or players whose team was removed) land on the smallest team. */
  assignNewcomers = () =>
    this.act(async () => {
      const teams = this.teams;
      if (!teams.length) return;
      for (const p of this.players) {
        if (p.team_id && teams.some((t) => t.id === p.team_id)) continue;
        await this.setPlayerTeam(p.id, smallestTeam(this.players, teams).id);
      }
    });

  /** Run a host-only action defined by the current game (e.g. rule on a challenge). */
  gameAction = (name: string, payload: Record<string, unknown> = {}) =>
    this.act(async () => {
      const mod = this.module;
      if (mod?.action && this.snap.run) await mod.action(this.ctx(), name, payload);
    });

  showAwards = () =>
    this.act(async () => {
      const run = this.snap.run;
      if (run && run.status !== 'done' && run.status !== 'exited') {
        await this.patchRun({ status: 'exited', ended_at: new Date().toISOString() });
      }
      const { awards, recap } = await computeNight(this.room.id, this.players, this.teams);
      await this.patchRoom({
        phase: 'awards', current_game: null, current_run_id: null, round: 0, rounds_total: 0,
        state: { awards, stage: 0 }, settings: { ...this.room.settings, recap }, ...CLEAR_TIMER,
      });
      await this.loadRuns();
    }, 'advance');

  kick = (playerId: string) =>
    this.act(async () => {
      const { error } = await supabase.from('players').delete().eq('id', playerId);
      if (error) throw error;
      this.store.removePlayer(playerId);
    });

  updateSettings = (patch: Partial<RoomSettings>) =>
    this.act(async () => {
      await this.patchRoom({ settings: { ...this.room.settings, ...patch } });
    });

  /** Mirror Realtime Presence into players.connected so phones can see it too. */
  async syncConnected(online: Set<string>) {
    const changed = this.players.filter((p) => p.connected !== online.has(p.id));
    for (const p of changed) {
      await supabase.from('players').update({ connected: online.has(p.id) }).eq('id', p.id);
    }
  }

  // ---------------------------------------------------------------- heartbeat
  private tick() {
    const room = this.store.getSnapshot().room;
    const run = this.snap.run;
    const mod = this.module;
    if (!room || room.phase !== 'play' || !run || run.id !== room.current_run_id || !mod) return;
    if (room.state.paused || this.pendingKeys.get('advance')) return;

    // 1. Step timer expired.
    const ends = room.timer_ends_at;
    if (ends && serverNow() >= Date.parse(ends)) {
      if (this.autoFiredFor !== `t:${ends}`) {
        void this.act(async () => {
          if (this.room.timer_ends_at !== ends) return;
          this.autoFiredFor = `t:${ends}`;
          const ctx = this.ctx();
          await (mod.onTimerEnd ? mod.onTimerEnd(ctx) : mod.next(ctx));
        }, 'advance');
        return;
      }
    }

    if (this.pending > 0) return;

    // 1b. Let the game validate fresh input (reject bad answers, etc).
    if (mod.process) {
      const sig =
        `${room.round}:${room.state.step ?? ''}:${String(room.state.stepAt ?? '')}:` +
        this.snap.subs.filter((s) => s.round === room.round).map((s) => s.id + s.updated_at).join('|');
      if (sig !== this.lastProcessSig) {
        this.lastProcessSig = sig;
        void this.act(async () => {
          await mod.process!(this.ctx());
        });
        return;
      }
    }

    // 2. Publish who has answered (drives "waiting on…" on every screen).
    const acc = room.state.accept;
    if (acc) {
      const ids = new Set<string>();
      const track = acc.track ?? (acc.submit?.length ? 'submit' : 'vote');
      if (track === 'submit') {
        for (const s of this.snap.subs) {
          if (s.round === room.round && s.player_id && (acc.count ?? acc.submit)?.includes(s.kind)) ids.add(s.player_id);
        }
      } else {
        for (const v of this.snap.votes) {
          if (v.round === room.round && acc.vote?.includes(v.kind)) ids.add(v.voter_id);
        }
      }
      const done = [...ids].sort();
      if (done.join() !== [...(room.state.done ?? [])].sort().join()) {
        void this.act(async () => {
          await this.patchRoom({ state: { ...this.room.state, done } });
        });
        return;
      }
    }

    // 3. Module-specific auto-advance (e.g. everyone answered), at most once per step.
    const stepKey = `s:${room.round}:${room.state.step ?? ''}:${String(room.state.stepAt ?? '')}`;
    if (mod.ready && this.autoFiredFor !== stepKey && mod.ready(this.ctx())) {
      this.autoFiredFor = stepKey;
      void this.act(async () => {
        await mod.next(this.ctx());
      }, 'advance');
      return;
    }

    // 4. Safety net in case a realtime event was missed.
    if (Date.now() - this.lastPoll > 5000) {
      this.lastPoll = Date.now();
      void this.loadRun(room.current_run_id);
    }
  }
}

export function useEngine(engine: HostEngine | null): EngineSnapshot | null {
  return useSyncExternalStore(engine?.subscribe ?? noop, engine?.getSnapshot ?? nil);
}
const noop = () => () => {};
const nil = () => null;
