import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Player, Room, Team } from './types';

export type RoomStatus = 'loading' | 'ready' | 'missing' | 'error';

export interface RoomSnapshot {
  status: RoomStatus;
  error?: string;
  room: Room | null;
  players: Player[];
  teams: Team[];
  /** False while the realtime socket is down (we keep showing the last known state). */
  live: boolean;
}

const byJoin = (a: Player, b: Player) => a.joined_at.localeCompare(b.joined_at);

/**
 * Loads one room + its players and keeps them in sync via Supabase Realtime.
 * Used by both the TV and phones. Survives refreshes and flaky Wi-Fi: every
 * (re)subscribe, tab focus, and a slow safety poll triggers a full refetch.
 */
export class RoomStore {
  private snap: RoomSnapshot = { status: 'loading', room: null, players: [], teams: [], live: false };
  private listeners = new Set<() => void>();
  private channel: RealtimeChannel | null = null;
  private teamsChannel: RealtimeChannel | null = null;
  private poll: number | undefined;
  private stopped = false;

  constructor(readonly code: string) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  private set(patch: Partial<RoomSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  async start() {
    await this.refresh();
    if (this.stopped) return;
    const room = this.snap.room;
    if (room) this.listen(room.id);
    window.addEventListener('focus', this.onWake);
    document.addEventListener('visibilitychange', this.onWake);
    window.addEventListener('online', this.onWake);
    this.poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh();
    }, 20000);
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('focus', this.onWake);
    document.removeEventListener('visibilitychange', this.onWake);
    window.removeEventListener('online', this.onWake);
    window.clearInterval(this.poll);
    if (this.channel) void supabase.removeChannel(this.channel);
    if (this.teamsChannel) void supabase.removeChannel(this.teamsChannel);
    this.listeners.clear();
  }

  private onWake = () => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  async refresh() {
    const { data: room, error } = await supabase.from('rooms').select('*').eq('code', this.code).maybeSingle();
    if (this.stopped) return;
    if (error) return this.set({ status: this.snap.room ? this.snap.status : 'error', error: error.message });
    if (!room) return this.set({ status: 'missing', room: null, players: [], teams: [] });
    const { data: players, error: pErr } = await supabase.from('players').select('*').eq('room_id', room.id);
    if (this.stopped) return;
    if (pErr) return this.set({ error: pErr.message });
    const { data: teams } = await supabase.from('teams').select('*').eq('room_id', room.id);
    const cur = this.snap.room;
    const fresh = !cur || cur.id !== room.id || Date.parse(room.updated_at) >= Date.parse(cur.updated_at);
    this.set({
      status: 'ready',
      error: undefined,
      room: fresh ? (room as Room) : cur,
      players: (players as Player[]).sort(byJoin),
      teams: sortTeams((teams ?? []) as Team[]),
    });
  }

  /** Apply a room row we received (from realtime or our own write), ignoring stale ones. */
  applyRoom(row: Room) {
    const cur = this.snap.room;
    if (cur && Date.parse(row.updated_at) < Date.parse(cur.updated_at)) return;
    this.set({ room: row, status: 'ready' });
  }

  applyPlayer(row: Player) {
    const others = this.snap.players.filter((p) => p.id !== row.id);
    this.set({ players: [...others, row].sort(byJoin) });
  }

  applyTeams(teams: Team[]) {
    this.set({ teams: sortTeams(teams) });
  }

  removePlayer(id: string) {
    if (!this.snap.players.some((p) => p.id === id)) return;
    this.set({ players: this.snap.players.filter((p) => p.id !== id) });
  }

  private listenTeams(roomId: string) {
    this.teamsChannel = supabase
      .channel(`teams:${roomId}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `room_id=eq.${roomId}` }, (p) => {
        if (p.eventType === 'DELETE') this.applyTeams(this.snap.teams.filter((t) => t.id !== (p.old as { id: string }).id));
        else this.applyTeams([...this.snap.teams.filter((t) => t.id !== (p.new as Team).id), p.new as Team]);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'teams' }, (p) => {
        this.applyTeams(this.snap.teams.filter((t) => t.id !== (p.old as { id: string }).id));
      })
      .subscribe();
  }

  private listen(roomId: string) {
    this.listenTeams(roomId);
    this.channel = supabase
      .channel(`room-db:${roomId}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, (p) => {
        if (p.eventType === 'DELETE') this.set({ status: 'missing', room: null });
        else this.applyRoom(p.new as Room);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${roomId}` }, (p) => {
        if (p.eventType === 'DELETE') this.removePlayer((p.old as { id: string }).id);
        else this.applyPlayer(p.new as Player);
      })
      // Postgres delete events can't be filtered, so listen to them unfiltered too.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players' }, (p) => {
        this.removePlayer((p.old as { id: string }).id);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.set({ live: true });
          void this.refresh(); // close the gap between first fetch and subscribe, and after reconnects
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.set({ live: false });
        }
      });
  }
}

/** React binding: one RoomStore per code, torn down on unmount or code change. */
export function useRoomStore(code: string | null): { store: RoomStore | null; snap: RoomSnapshot | null } {
  const [store, setStore] = useState<RoomStore | null>(null);

  useEffect(() => {
    if (!code) {
      setStore(null);
      return;
    }
    const s = new RoomStore(code);
    setStore(s);
    void s.start();
    return () => s.stop();
  }, [code]);

  const snap = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? nullSnapshot,
  );
  return { store, snap };
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

export function sortTeams(teams: Team[]): Team[] {
  return [...teams].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
