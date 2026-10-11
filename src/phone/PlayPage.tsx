import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SetupNeeded } from '../components/HostGate';
import { syncClock } from '../lib/clock';
import { usePresence } from '../lib/presence';
import { useRoomStore } from '../lib/roomStore';
import { load, save } from '../lib/storage';
import { ensureSession, errorCode, isConfigured, slot, storageSuffix } from '../lib/supabase';
import type { Player } from '../lib/types';
import { useTheme } from '../themes/themes';
import { JoinFlow } from './JoinFlow';
import { PhoneShell } from './PhoneShell';

const KEY = `partypack:phone${storageSuffix}`;

interface Saved {
  code: string;
  playerId?: string;
}

/** /play — join with a room code, then play. Identity survives refresh via localStorage. */
export function PlayPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const urlCode = params.get('code')?.toUpperCase() ?? null;
  const [saved, setSaved] = useState<Saved | null>(() => load<Saved | null>(KEY, null));
  const code = urlCode ?? saved?.code ?? null;
  const [uid, setUid] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConfigured) return;
    ensureSession()
      .then((s) => setUid(s.user.id))
      .catch((e) => setAuthError(errorCode(e)));
    void syncClock();
  }, []);

  const goToCode = useCallback(
    (c: string | null) => {
      const q = new URLSearchParams();
      if (c) q.set('code', c);
      if (slot) q.set('as', slot);
      navigate(`/play${q.size ? `?${q}` : ''}`, { replace: true });
    },
    [navigate],
  );

  if (!isConfigured) return <SetupNeeded />;
  if (authError) {
    return (
      <div className="phone-page center-stack">
        <h1 className="display phone-title">Can't connect</h1>
        <p className="error">{authError}</p>
        <button className="btn btn-primary btn-lg" onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }
  if (!code) {
    return (
      <CodeEntry
        onSubmit={(c) => {
          setSaved({ code: c });
          save(KEY, { code: c });
          goToCode(c);
        }}
      />
    );
  }
  if (!uid) return <Loading />;

  return (
    <PhoneRoom
      key={code}
      code={code}
      uid={uid}
      savedPlayerId={saved?.code === code ? saved.playerId : undefined}
      onJoined={(p) => {
        const s = { code, playerId: p.id };
        setSaved(s);
        save(KEY, s);
      }}
      onLeave={() => {
        setSaved(null);
        save(KEY, null);
        goToCode(null);
      }}
    />
  );
}

function PhoneRoom({
  code,
  uid,
  savedPlayerId,
  onJoined,
  onLeave,
}: {
  code: string;
  uid: string;
  savedPlayerId?: string;
  onJoined: (p: Player) => void;
  onLeave: () => void;
}) {
  const { store, snap } = useRoomStore(code);
  const [dismissed, setDismissed] = useState(false);
  const room = snap?.room ?? null;
  const players = snap?.players ?? [];
  const me = players.find((p) => p.user_id === uid) ?? null;
  usePresence(code, me?.id ?? null);
  useTheme(room?.settings.theme);

  // Remember who we are as soon as we're in the room (also covers rejoin-by-session).
  useEffect(() => {
    if (me && me.id !== savedPlayerId) onJoined(me);
  }, [me, savedPlayerId, onJoined]);

  if (!snap || snap.status === 'loading') return <Loading />;

  if (snap.status === 'missing' || room?.settings.closed) {
    return (
      <div className="phone-page center-stack">
        <h1 className="display phone-title">{room?.settings.closed ? `Room ${code} has ended` : `Room ${code} not found`}</h1>
        <p className="dim">Check the code on the TV.</p>
        <button className="btn btn-primary btn-lg" onClick={onLeave}>Enter a different code</button>
      </div>
    );
  }
  if (snap.status === 'error' || !room) {
    return (
      <div className="phone-page center-stack">
        <p className="error">{snap.error ?? 'Something went wrong'}</p>
        <button className="btn btn-primary btn-lg" onClick={() => void store?.refresh()}>Retry</button>
      </div>
    );
  }

  if (!me) {
    // We had a player here before but it's no longer ours: kicked, or moved to another phone.
    const previous = savedPlayerId ? players.find((p) => p.id === savedPlayerId) : undefined;
    if (savedPlayerId && !dismissed) {
      return (
        <div className="phone-page center-stack">
          <h1 className="display phone-title">{previous ? 'Playing on another phone' : 'You were removed'}</h1>
          <p className="dim">
            {previous
              ? `${previous.name} is now signed in on a different device.`
              : 'The host removed you from the room. You can join again.'}
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => setDismissed(true)}>Join again</button>
        </div>
      );
    }
    return (
      <JoinFlow
        room={room}
        players={players}
        onJoined={(p) => {
          store?.applyPlayer(p);
          onJoined(p);
        }}
      />
    );
  }

  return <PhoneShell room={room} players={players} me={me} live={snap.live} onPlayerUpdated={(p) => store?.applyPlayer(p)} onLeave={onLeave} />;
}

function CodeEntry({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [value, setValue] = useState('');
  const clean = value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  return (
    <form
      className="phone-page center-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean.length === 4) onSubmit(clean);
      }}
    >
      <h1 className="display phone-title">Party Pack</h1>
      <p className="dim">Enter the room code from the TV</p>
      <input
        className="input input-code"
        autoFocus
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        value={clean}
        onChange={(e) => setValue(e.target.value)}
        placeholder="ABCD"
      />
      <button className="btn btn-primary btn-lg btn-block" disabled={clean.length !== 4}>
        Join
      </button>
    </form>
  );
}

function Loading() {
  return (
    <div className="phone-page center-stack">
      <div className="spinner" />
    </div>
  );
}
