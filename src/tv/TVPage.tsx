import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_ROSTER, DEFAULT_THEME } from '../config';
import { HostGate } from '../components/HostGate';
import { syncClock } from '../lib/clock';
import { usePresence } from '../lib/presence';
import { useRoomStore } from '../lib/roomStore';
import { TeamsContext } from '../lib/teamsContext';
import { unlockAudio } from '../lib/sound';
import { load, save } from '../lib/storage';
import { errorCode, supabase } from '../lib/supabase';
import type { Room } from '../lib/types';
import { useTheme } from '../themes/themes';
import { HostEngine, useEngine } from './engine';
import { BigQr } from './BigQr';
import { HostDrawer } from './HostDrawer';
import { TeamSetup } from './TeamSetup';
import { TVScreens } from './TVScreens';

const ROOM_KEY = 'partypack:tv-room';

export function TVPage() {
  return (
    <HostGate label="Party Pack · TV">
      <TVRoom />
    </HostGate>
  );
}

/** Resolves which room this TV runs (remembered across refreshes), creating one if needed. */
function TVRoom() {
  const [code, setCode] = useState<string | null>(() => load<string | null>(ROOM_KEY, null));
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);

  const createRoom = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    setError(null);
    try {
      const { data, error } = await supabase.rpc('create_room', {
        p_settings: { theme: DEFAULT_THEME, roster: DEFAULT_ROSTER },
      });
      if (error) return setError(errorCode(error));
      const room = data as Room;
      save(ROOM_KEY, room.code);
      setCode(room.code);
    } finally {
      creating.current = false;
    }
  }, []);

  useEffect(() => {
    void syncClock();
    if (!code) void createRoom();
  }, [code, createRoom]);

  if (error) {
    return (
      <div className="screen center-stack narrow">
        <h1 className="display">Couldn't create a room</h1>
        <p className="error">{error}</p>
        <button className="btn btn-primary" onClick={() => void createRoom()}>Try again</button>
      </div>
    );
  }
  if (!code) return <div className="screen center-stack"><div className="spinner" /></div>;
  return <TVRunner key={code} code={code} onNewRoom={createRoom} onMissing={createRoom} />;
}

function TVRunner({ code, onNewRoom, onMissing }: { code: string; onNewRoom: () => Promise<void>; onMissing: () => Promise<void> }) {
  const { store, snap } = useRoomStore(code);
  const [engine, setEngine] = useState<HostEngine | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [bigQr, setBigQr] = useState(false);
  const [teamSetup, setTeamSetup] = useState(false);
  const teamSetupRef = useRef(false);
  teamSetupRef.current = teamSetup;
  const engineSnap = useEngine(engine);
  const online = usePresence(code, null);
  const roomReady = snap?.status === 'ready';

  useTheme(snap?.room?.settings.theme);

  // Start the engine once the room has loaded.
  useEffect(() => {
    if (!store || !roomReady) return;
    const e = new HostEngine(store);
    e.start();
    setEngine(e);
    return () => {
      e.stop();
      setEngine(null);
    };
  }, [store, roomReady]);

  useEffect(() => {
    if (snap?.status === 'missing') void onMissing();
  }, [snap?.status, onMissing]);

  // Mirror presence into players.connected, debounced so a reload doesn't flicker everyone offline.
  const onlineKey = [...online].sort().join();
  useEffect(() => {
    if (!engine) return;
    const t = window.setTimeout(() => void engine.syncConnected(online), 3000);
    return () => window.clearTimeout(t);
  }, [engine, onlineKey, snap?.players.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Teams: late joiners land on the smallest team.
  const unassigned = Boolean(snap?.teams.length && snap.players.some((p) => !p.team_id || !snap.teams.some((t) => t.id === p.team_id)));
  useEffect(() => {
    if (engine && unassigned) void engine.assignNewcomers();
  }, [engine, unassigned, snap?.players.length]);

  // Keyboard shortcuts: H drawer, Space next, + add 15s.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      unlockAudio();
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.modal')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (teamSetupRef.current) {
        if (e.key === 'Escape' || e.key === 't' || e.key === 'T') setTeamSetup(false);
        return;
      }
      if (e.key === 'h' || e.key === 'H') {
        setDrawer((d) => !d);
      } else if (e.key === 'p' || e.key === 'P') {
        void engine?.togglePause();
      } else if (e.key === 't' || e.key === 'T') {
        setTeamSetup(true);
      } else if (e.key === 'q' || e.key === 'Q') {
        setBigQr((v) => !v);
      } else if (e.key === 'Escape') {
        setBigQr(false);
      } else if (e.key === 's' || e.key === 'S') {
        void engine?.skip();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        void engine?.gameAction('enter');
      } else if (e.key === ' ') {
        // Don't let Space also "click" whichever drawer button has focus.
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        if (!e.repeat) void engine?.next();
      } else if (e.key === '+' || e.key === '=') {
        void engine?.addTime(15);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  if (!snap || snap.status === 'loading' || !snap.room || !engine || !engineSnap) {
    return (
      <div className="screen center-stack">
        <div className="spinner" />
        {snap?.error && <p className="error">{snap.error}</p>}
      </div>
    );
  }

  return (
    <TeamsContext.Provider value={snap.teams}>
    <div className="tv" onClick={unlockAudio}>
      {teamSetup && <TeamSetup teams={snap.teams} players={snap.players} engine={engine} onClose={() => setTeamSetup(false)} />}
      {bigQr && <BigQr code={snap.room.code} onClose={() => setBigQr(false)} />}
      <TVScreens room={snap.room} players={snap.players} teams={snap.teams} openTeams={() => setTeamSetup(true)} engine={engine} engineSnap={engineSnap} online={online} />
      {!snap.live && <div className="tv-offline">Reconnecting…</div>}
      {engineSnap.error && !drawer && (
        <button className="tv-error" onClick={engine.clearError}>
          ⚠ {engineSnap.error} <span className="dim">(click to dismiss)</span>
        </button>
      )}
      <HostDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        teams={snap.teams}
        onOpenTeams={() => {
          setDrawer(false);
          setTeamSetup(true);
        }}
        onShowQr={() => {
          setDrawer(false);
          setBigQr(true);
        }}
        room={snap.room}
        players={snap.players}
        online={online}
        engine={engine}
        engineSnap={engineSnap}
        onNewRoom={async () => {
          // Tell phones in the old room it's over so they land back on code entry.
          await engine.updateSettings({ closed: true });
          await onNewRoom();
        }}
      />
      {!drawer && <div className="tv-hint">H · host controls</div>}
    </div>
    </TeamsContext.Provider>
  );
}
