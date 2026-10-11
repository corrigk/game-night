import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * Realtime Presence for a room. Phones announce their player id; the TV watches
 * and gets the set of player ids currently connected.
 *
 * One shared channel per room code for the page's lifetime: realtime-js hands back
 * the existing channel for a repeated topic, so tearing down and re-creating it
 * (React remounts, joining after the page loaded) would race.
 */
interface Hub {
  channel: RealtimeChannel;
  online: Set<string>;
  listeners: Set<(s: Set<string>) => void>;
  subscribed: boolean;
  me: string | null;
}

const hubs = new Map<string, Hub>();

function syncTrack(hub: Hub) {
  if (!hub.subscribed) return;
  void (hub.me ? hub.channel.track({ player_id: hub.me }) : hub.channel.untrack());
}

function getHub(code: string): Hub {
  const existing = hubs.get(code);
  if (existing) return existing;

  const key = Math.random().toString(36).slice(2, 12); // crypto.randomUUID needs https; LAN dev is http
  const channel = supabase.channel(`presence:${code}`, { config: { presence: { key } } });
  const hub: Hub = { channel, online: new Set(), listeners: new Set(), subscribed: false, me: null };

  channel
    .on('presence', { event: 'sync' }, () => {
      const ids = Object.values(channel.presenceState())
        .flat()
        .map((m) => (m as { player_id?: string }).player_id)
        .filter((id): id is string => Boolean(id));
      hub.online = new Set(ids);
      hub.listeners.forEach((fn) => fn(hub.online));
    })
    .subscribe((status) => {
      hub.subscribed = status === 'SUBSCRIBED';
      if (hub.subscribed) syncTrack(hub); // also re-announces after a reconnect
    });

  hubs.set(code, hub);
  return hub;
}

export function usePresence(code: string | null, playerId: string | null): Set<string> {
  const [online, setOnline] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!code) return;
    const hub = getHub(code);
    hub.listeners.add(setOnline);
    setOnline(hub.online);
    if (hub.me !== playerId) {
      hub.me = playerId;
      syncTrack(hub);
    }
    return () => {
      hub.listeners.delete(setOnline);
    };
  }, [code, playerId]);

  return online;
}
