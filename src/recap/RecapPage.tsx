import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SetupNeeded } from '../components/HostGate';
import { ensureSession, isConfigured, supabase } from '../lib/supabase';
import type { RoomSettings } from '../lib/types';
import { useTheme } from '../themes/themes';
import type { Recap } from '../tv/awards';
import { renderRecapImage } from './recapImage';

/** /recap?code=XXXX: the night's scoreboard, awards and best moments. Anyone with the link can view it. */
export function RecapPage() {
  const [params] = useSearchParams();
  const code = params.get('code')?.toUpperCase() ?? '';
  const [settings, setSettings] = useState<RoomSettings | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'none' | 'error'>('loading');
  const [msg, setMsg] = useState<string | null>(null);
  const recap = settings?.recap as Recap | undefined;
  useTheme(settings?.theme);

  useEffect(() => {
    if (!isConfigured || !code) return;
    (async () => {
      try {
        await ensureSession();
        const { data, error } = await supabase.from('rooms').select('settings').eq('code', code).maybeSingle();
        if (error) throw error;
        setSettings((data?.settings as RoomSettings | undefined) ?? null);
        setStatus(data?.settings && (data.settings as RoomSettings).recap ? 'ready' : 'none');
      } catch {
        setStatus('error');
      }
    })();
  }, [code]);

  if (!isConfigured) return <SetupNeeded />;
  if (!code) return <Notice title="No room code" body="Open the recap link from the TV or your phone's awards screen." />;
  if (status === 'loading') return <div className="phone-page center-stack"><div className="spinner" /></div>;
  if (status === 'error') return <Notice title="Couldn't load the recap" body="Check your connection and try again." />;
  if (status === 'none' || !recap) return <Notice title="No recap yet" body="The recap appears once the host runs the Final Awards at the end of the night." />;

  const link = window.location.href;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Game Night Recap', url: link });
      else {
        await navigator.clipboard.writeText(link);
        setMsg('Link copied!');
      }
    } catch {
      // cancelled
    }
  };
  const saveImage = async () => {
    setMsg('Making your image…');
    try {
      const blob = await renderRecapImage(recap);
      const file = new File([blob], 'game-night-recap.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Game Night Recap' });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'game-night-recap.png';
        a.click();
        URL.revokeObjectURL(a.href);
      }
      setMsg(null);
    } catch {
      setMsg('Could not save the image.');
    }
  };

  const medals = ['🥇', '🥈', '🥉'];
  return (
    <div className="phone-page recap">
      <h1 className="display phone-title">🎉 Game Night Recap</h1>
      <p className="dim">
        {new Date(recap.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        {recap.games.length > 0 && ` · ${recap.games.join(', ')}`}
      </p>
      <div className="row gap wrap">
        <button className="btn btn-primary" onClick={() => void saveImage()}>📸 Save as image</button>
        <button className="btn" onClick={() => void share()}>🔗 Share link</button>
      </div>
      {msg && <p className="admin-msg">{msg}</p>}

      <section className="card">
        <h2>Final standings</h2>
        <ol className="recap-list">
          {recap.players.map((p, i) => (
            <li key={p.name + i}>
              <span className="recap-rank">{medals[i] ?? i + 1}</span>
              <span className="avatar avatar-sm" style={{ ['--pc' as string]: p.color }}>{p.emoji}</span>
              <span className="grow">{p.name}</span>
              <b>{p.score.toLocaleString()}</b>
            </li>
          ))}
        </ol>
      </section>

      {recap.teams.length > 0 && (
        <section className="card">
          <h2>Teams</h2>
          <ol className="recap-list">
            {recap.teams.map((t) => (
              <li key={t.name}>
                <span className="grow">{t.emoji} {t.name} <span className="dim small">({t.members.join(', ')})</span></span>
                <b>{t.total.toLocaleString()}</b>
              </li>
            ))}
          </ol>
        </section>
      )}

      {recap.awards.length > 0 && (
        <section className="card">
          <h2>Awards</h2>
          <ul className="recap-list">
            {recap.awards.map((a) => (
              <li key={a.title} className="recap-award">
                <span className="recap-emoji">{a.emoji}</span>
                <span className="grow">
                  <b>{a.title}</b>
                  <br />
                  {a.names.join(' & ')} <span className="dim small">· {a.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recap.moments.length > 0 && (
        <section className="card">
          <h2>Best moments</h2>
          <ul className="recap-list">
            {recap.moments.map((m) => (
              <li key={m.title} className="recap-award">
                <span className="recap-emoji">{m.emoji}</span>
                <span className="grow">
                  <b>{m.title}</b>
                  <br />
                  {m.text} <span className="dim">— {m.by}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="phone-page center-stack">
      <h1 className="display phone-title">{title}</h1>
      <p className="dim">{body}</p>
    </div>
  );
}
