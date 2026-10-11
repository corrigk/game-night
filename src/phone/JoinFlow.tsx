import { useState } from 'react';
import { DEFAULT_ROSTER } from '../config';
import { Confirm } from '../components/Modal';
import { Avatar } from '../components/PlayerChip';
import { errorCode, supabase } from '../lib/supabase';
import type { Player, Room } from '../lib/types';
import { LookPicker, randomFreeLook, takenColorsFor } from './LookPicker';

const MESSAGES: Record<string, string> = {
  NAME_TAKEN: 'Someone already joined with that name.',
  COLOR_TAKEN: 'That color was just taken. Pick another.',
  ROOM_FULL: 'This room is full.',
  BAD_NAME: 'Names need 1–24 characters.',
  ROOM_NOT_FOUND: "That room doesn't exist anymore.",
};

export function JoinFlow({ room, players, onJoined }: { room: Room; players: Player[]; onJoined: (p: Player) => void }) {
  const [step, setStep] = useState<'name' | 'custom' | 'look'>('name');
  const [name, setName] = useState('');
  const [look, setLook] = useState(() => randomFreeLook(players));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reclaim, setReclaim] = useState<Player | null>(null);

  const roster = room.settings.roster?.length ? room.settings.roster : DEFAULT_ROSTER;
  const byName = new Map(players.map((p) => [p.name.toLowerCase(), p]));
  const extras = players.filter((p) => !roster.some((r) => r.toLowerCase() === p.name.toLowerCase()));
  const taken = takenColorsFor(players);

  const pickName = (n: string) => {
    const existing = byName.get(n.toLowerCase());
    if (existing) return setReclaim(existing);
    setName(n);
    setError(null);
    if (taken.has(look.color.toLowerCase())) setLook(randomFreeLook(players));
    setStep('look');
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc('join_room', {
        p_code: room.code,
        p_name: name,
        p_emoji: look.emoji,
        p_color: look.color,
      });
      if (error) throw error;
      onJoined(data as Player);
    } catch (e) {
      const code = errorCode(e);
      setError(MESSAGES[code] ?? code);
      if (code === 'NAME_TAKEN') setStep('name');
    } finally {
      setBusy(false);
    }
  };

  const doReclaim = async (p: Player) => {
    setReclaim(null);
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('reclaim_player', { p_player_id: p.id });
      if (error) throw error;
      onJoined(data as Player);
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="phone-page">
      {step === 'name' && (
        <>
          <h1 className="display phone-title">Who are you?</h1>
          <p className="dim">Room {room.code}</p>
          <div className="name-grid">
            {roster.map((n) => {
              const p = byName.get(n.toLowerCase());
              return (
                <button key={n} className={`name-option${p ? ' joined' : ''}`} onClick={() => pickName(n)}>
                  {p && <Avatar player={p} size="sm" />}
                  <span>{n}</span>
                </button>
              );
            })}
            {extras.map((p) => (
              <button key={p.id} className="name-option joined" onClick={() => pickName(p.name)}>
                <Avatar player={p} size="sm" />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          <button className="btn btn-lg btn-block" onClick={() => setStep('custom')}>
            I'm someone else
          </button>
        </>
      )}

      {step === 'custom' && (
        <form
          className="stack gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) pickName(name.trim());
          }}
        >
          <h1 className="display phone-title">What's your name?</h1>
          <input
            className="input input-lg"
            autoFocus
            maxLength={24}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="given-name"
          />
          <button className="btn btn-primary btn-lg btn-block" disabled={!name.trim()}>
            Next
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setStep('name')}>
            Back
          </button>
        </form>
      )}

      {step === 'look' && (
        <>
          <h1 className="display phone-title">Hi, {name}!</h1>
          <LookPicker name={name} emoji={look.emoji} color={look.color} takenColors={taken} onChange={setLook} />
          <button
            className="btn btn-primary btn-lg btn-block sticky-bottom"
            disabled={busy || taken.has(look.color.toLowerCase())}
            onClick={() => void join()}
          >
            {busy ? 'Joining…' : "Let's go!"}
          </button>
          <button className="btn btn-ghost btn-block" onClick={() => setStep('name')}>
            Back
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}

      {reclaim && (
        <Confirm
          title={`${reclaim.name} already joined`}
          body={`Is this you on a different phone? This phone will take over ${reclaim.name}'s spot and points.`}
          confirmLabel="Yes, that's me"
          onCancel={() => setReclaim(null)}
          onConfirm={() => void doReclaim(reclaim)}
        />
      )}
    </div>
  );
}
