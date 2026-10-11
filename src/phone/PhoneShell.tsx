import { useCallback, useEffect, useMemo, useState } from 'react';
import { Countdown } from '../components/Countdown';
import { Leaderboard } from '../components/Leaderboard';
import { Modal } from '../components/Modal';
import { Avatar, PlayerChip } from '../components/PlayerChip';
import { GAMES } from '../games/registry';
import type { PhoneApi } from '../games/types';
import { errorCode, supabase } from '../lib/supabase';
import type { Player, Room, Submission, Vote } from '../lib/types';
import { LookPicker, takenColorsFor } from './LookPicker';

/** My own submissions/votes for the current run + round (RLS returns only mine). */
function useMine(room: Room, me: Player) {
  const [mySubs, setSubs] = useState<Submission[]>([]);
  const [myVotes, setVotes] = useState<Vote[]>([]);
  const runId = room.current_run_id;
  const round = room.round;
  const stepAt = String(room.state.stepAt ?? '');

  const refresh = useCallback(async () => {
    if (!runId) {
      setSubs([]);
      setVotes([]);
      return;
    }
    const [s, v] = await Promise.all([
      supabase.from('submissions').select('*').eq('run_id', runId).eq('round', round).eq('player_id', me.id),
      supabase.from('votes').select('*').eq('run_id', runId).eq('round', round).eq('voter_id', me.id),
    ]);
    setSubs((s.data ?? []) as Submission[]);
    setVotes((v.data ?? []) as Vote[]);
  }, [runId, round, me.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, stepAt]);

  return { mySubs, myVotes, refresh };
}

export function PhoneShell({
  room,
  players,
  me,
  live,
  onPlayerUpdated,
  onLeave,
}: {
  room: Room;
  players: Player[];
  me: Player;
  live: boolean;
  onPlayerUpdated: (p: Player) => void;
  onLeave: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const { mySubs, myVotes, refresh } = useMine(room, me);
  const game = room.current_game ? GAMES[room.current_game] : undefined;

  const api: PhoneApi = useMemo(
    () => ({
      mySubs,
      myVotes,
      async submit(kind, payload) {
        const { error } = await supabase.rpc('submit', { p_room_id: room.id, p_kind: kind, p_payload: payload });
        if (error) throw error;
        if (navigator.vibrate) navigator.vibrate(30);
        await refresh();
      },
      async vote(kind, target) {
        const { error } = await supabase.rpc('cast_vote', {
          p_room_id: room.id,
          p_kind: kind,
          p_target_submission_id: target.submissionId ?? null,
          p_target_player_id: target.playerId ?? null,
        });
        if (error) throw error;
        if (navigator.vibrate) navigator.vibrate(30);
        await refresh();
      },
    }),
    [mySubs, myVotes, room.id, refresh],
  );

  const sorted = [...players].sort((a, b) => b.score - a.score);
  const rank = sorted.findIndex((p) => p.id === me.id) + 1;

  return (
    <div className="phone-shell">
      <header className="phone-header">
        <button className="phone-me" onClick={() => setEditing(true)} aria-label="Change emoji or color">
          <Avatar player={me} size="md" />
          <span className="phone-me-name">{me.name}</span>
        </button>
        <div className="phone-header-right">
          {room.phase === 'play' && !room.state.hideTimer && (
            <Countdown endsAt={room.timer_ends_at} duration={room.timer_duration} size="sm" />
          )}
          <span className="phone-score">{me.score.toLocaleString()} pts</span>
        </div>
      </header>
      {!live && <div className="phone-offline">Reconnecting…</div>}

      <main className="phone-main">
        {room.phase === 'lobby' && (
          <div className="phone-center center-stack">
            <PlayerChip player={me} size="xl" />
            <h1 className="display phone-title">You're in!</h1>
            <p className="dim">Waiting for the host to start. Tap your name up top to change your look.</p>
          </div>
        )}

        {room.phase === 'hub' && (
          <div className="phone-page">
            <h2 className="center">The host is picking a game…</h2>
            {rank > 0 && players.some((p) => p.score > 0) && <p className="center lead">You're #{rank}</p>}
            <div className="card">
              <Leaderboard players={players} highlightId={me.id} title="Tonight" />
            </div>
          </div>
        )}

        {room.phase === 'intro' && game && (
          <div className="phone-center center-stack">
            <div className="intro-emoji">{game.emoji}</div>
            <h1 className="display phone-title">{game.title}</h1>
            <ol className="rules rules-phone">
              {game.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
            <p className="dim">Watch the TV. Starting soon…</p>
          </div>
        )}

        {room.phase === 'play' && game && (
          <>
            <div className="phone-round dim small">
              {game.emoji} {game.title} · Round {room.round}/{room.rounds_total}
            </div>
            <game.Phone room={room} me={me} players={players} api={api} />
          </>
        )}

        {room.phase === 'results' && <PhoneResults room={room} me={me} rank={rank} />}

        {room.phase === 'awards' && (
          <div className="phone-center center-stack">
            <h1 className="display phone-title">🏆 Awards time</h1>
            <p className="dim">Look at the TV!</p>
          </div>
        )}
      </main>

      {editing && <EditLook me={me} players={players} onClose={() => setEditing(false)} onSaved={onPlayerUpdated} onLeave={onLeave} />}
    </div>
  );
}

function PhoneResults({ room, me, rank }: { room: Room; me: Player; rank: number }) {
  const standings = (room.state.standings as { playerId: string; points: number }[] | undefined) ?? [];
  const mine = standings.find((s) => s.playerId === me.id)?.points ?? 0;
  const game = room.current_game ? GAMES[room.current_game] : undefined;
  return (
    <div className="phone-center center-stack">
      <h2>{game?.title} is over</h2>
      {game?.scored !== false && <p className="points big-num">+{mine}</p>}
      <p className="lead">
        {me.score.toLocaleString()} total · #{rank} tonight
      </p>
    </div>
  );
}

function EditLook({ me, players, onClose, onSaved, onLeave }: { me: Player; players: Player[]; onClose: () => void; onSaved: (p: Player) => void; onLeave: () => void }) {
  const [look, setLook] = useState({ emoji: me.emoji, color: me.color });
  const [error, setError] = useState<string | null>(null);
  const taken = takenColorsFor(players, me.id);

  const saveLook = async () => {
    const { data, error } = await supabase.rpc('update_me', { p_player_id: me.id, p_emoji: look.emoji, p_color: look.color });
    if (error) return setError(errorCode(error) === 'COLOR_TAKEN' ? 'That color was just taken.' : errorCode(error));
    onSaved(data as Player);
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <LookPicker name={me.name} emoji={look.emoji} color={look.color} takenColors={taken} onChange={setLook} />
      {error && <p className="error">{error}</p>}
      <div className="row gap end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void saveLook()}>Save</button>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onLeave}>Leave room / enter a different code</button>
    </Modal>
  );
}
