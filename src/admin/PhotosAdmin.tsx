import { useCallback, useEffect, useState } from 'react';
import { downscale, randomId } from '../lib/image';
import { errorCode, supabase } from '../lib/supabase';

interface Row {
  id: string;
  url: string | null;
  storage_path: string | null;
  pool: 'generic' | 'friends';
  credit: string | null;
  vetoed?: boolean | null;
  times_used?: number | null;
  preview?: string;
}

/** Upload caption photos to the private `caption-images` bucket (friends pool) or add generic ones. */
export function PhotosAdmin() {
  const [rows, setRows] = useState<Row[]>([]);
  const [pool, setPool] = useState<'generic' | 'friends'>('friends');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [urlText, setUrlText] = useState('');

  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('caption_images').select('*').order('created_at', { ascending: false });
    if (error) return setMsg(error.message);
    const list = (data ?? []) as Row[];
    const paths = list.filter((r) => r.storage_path).map((r) => r.storage_path!);
    const signed = new Map<string, string>();
    if (paths.length) {
      const { data: urls } = await supabase.storage.from('caption-images').createSignedUrls(paths, 3600);
      for (const u of urls ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
    }
    setRows(list.map((r) => ({ ...r, preview: r.url ?? signed.get(r.storage_path ?? '') })));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const blob = await downscale(file);
        const path = `${pool}/${randomId()}.jpg`;
        const up = await supabase.storage.from('caption-images').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw up.error;
        const ins = await supabase.from('caption_images').insert({ storage_path: path, pool });
        if (ins.error) throw ins.error;
        ok++;
      } catch (e) {
        failures.push(`${file.name}: ${errorCode(e)}`);
      }
    }
    setMsg(`Uploaded ${ok} photo${ok === 1 ? '' : 's'} to the ${pool} pool.${failures.length ? ' Failed: ' + failures.join('; ') : ''}`);
    setBusy(false);
    await reload();
  };

  const addUrl = async () => {
    const urls = urlText.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
    if (!urls.length) return setMsg('Paste one image URL per line (https://…).');
    const { error } = await supabase.from('caption_images').insert(urls.map((url) => ({ url, pool })));
    if (error) return setMsg(error.message);
    setUrlText('');
    setMsg(`Added ${urls.length} image URL${urls.length === 1 ? '' : 's'}.`);
    await reload();
  };

  const restore = async (r: Row) => {
    const { error } = await supabase.from('caption_images').update({ vetoed: false }).eq('id', r.id);
    if (error) return setMsg(error.message);
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, vetoed: false } : x)));
  };

  const remove = async (r: Row) => {
    if (r.storage_path) await supabase.storage.from('caption-images').remove([r.storage_path]);
    const { error } = await supabase.from('caption_images').delete().eq('id', r.id);
    if (error) return setMsg(error.message);
    setRows((rs) => rs.filter((x) => x.id !== r.id));
  };

  return (
    <section className="admin-section">
      <p className="dim">
        <b>friends</b> photos are uploaded to a private Supabase bucket and never touch the repo. <b>generic</b> is the
        everyone-can-caption pool. With no generic rows, the built-in placeholder pictures are used.
      </p>
      <div className="card admin-add">
        <div className="row gap wrap">
          <label className="field">
            <span>Pool</span>
            <select className="input" value={pool} onChange={(e) => setPool(e.target.value as 'generic' | 'friends')}>
              <option value="friends">friends</option>
              <option value="generic">generic</option>
            </select>
          </label>
          <label className="field">
            <span>Choose photos (several at once is fine)</span>
            <input type="file" accept="image/*" multiple disabled={busy} onChange={(e) => void upload(e.target.files)} />
          </label>
        </div>
        {busy && <p>Uploading…</p>}
        <label className="field" style={{ width: '100%' }}>
          <span>…or add image URLs (one per line)</span>
          <textarea className="input mono" rows={3} value={urlText} onChange={(e) => setUrlText(e.target.value)} />
        </label>
        <button className="btn btn-sm" onClick={() => void addUrl()} disabled={!urlText.trim()}>Add URLs</button>
      </div>
      {msg && <p className="admin-msg" onClick={() => setMsg(null)}>{msg}</p>}
      <strong>{rows.length} images</strong>
      <div className="photo-grid">
        {rows.map((r) => (
          <figure key={r.id} className="photo-tile">
            {r.preview ? <img src={r.preview} alt="" loading="lazy" /> : <div className="spinner" />}
            <figcaption>
              <span className={`pill pill-${r.pool}`}>{r.pool}</span>
              <span className="dim small">{Number(r.times_used ?? 0)}×</span>
              {r.vetoed && <button className="btn btn-sm btn-danger" onClick={() => void restore(r)}>retired ↺</button>}
              <button className="btn btn-sm btn-ghost" onClick={() => void remove(r)} aria-label="Delete photo">✕</button>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
