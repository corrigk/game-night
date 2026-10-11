import { useCallback, useEffect, useState } from 'react';
import { HostGate } from '../components/HostGate';
import { errorCode, supabase } from '../lib/supabase';
import { BANKS, cleanRow, type Bank, type BankField } from './banks';
import { PhotosAdmin } from './PhotosAdmin';

type Row = Record<string, unknown> & { id: string };

export function AdminPage() {
  return (
    <HostGate label="Party Pack · Admin">
      <Admin />
    </HostGate>
  );
}

function Admin() {
  const [tab, setTab] = useState<string>(BANKS[0].table);
  const bank = BANKS.find((b) => b.table === tab);
  return (
    <div className="admin">
      <header className="admin-header">
        <h1 className="display">Content</h1>
        <nav className="admin-tabs">
          {BANKS.map((b) => (
            <button key={b.table} className={`btn btn-sm${tab === b.table ? ' btn-primary' : ''}`} onClick={() => setTab(b.table)}>
              {b.label}
            </button>
          ))}
          <button className={`btn btn-sm${tab === 'photos' ? ' btn-primary' : ''}`} onClick={() => setTab('photos')}>
            Caption photos
          </button>
          <button className={`btn btn-sm${tab === 'import' ? ' btn-primary' : ''}`} onClick={() => setTab('import')}>
            Import everything
          </button>
        </nav>
      </header>
      {bank ? <BankEditor key={bank.table} bank={bank} /> : tab === 'photos' ? <PhotosAdmin /> : <ImportAll />}
    </div>
  );
}

// ------------------------------------------------------------------ one bank
function BankEditor({ bank }: { bank: Bank }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [json, setJson] = useState('');
  const [replace, setReplace] = useState(false);
  const hasSecrets = bank.fields.some((f) => f.secret);

  const reload = useCallback(async () => {
    const { data, error } = await supabase.from(bank.table).select('*').order('created_at');
    if (error) setMsg(error.message);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [bank.table]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    const row = cleanRow(bank, draft);
    if (!row) return setMsg('Fill in the required fields.');
    const { error } = await supabase.from(bank.table).insert(row);
    if (error) return setMsg(error.message);
    setDraft({});
    setMsg('Added.');
    await reload();
  };

  const update = async (id: string, field: BankField, value: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const next = cleanRow(bank, { ...row, [field.key]: value });
    if (!next) return setMsg(`${field.label} can't be empty.`);
    const { error } = await supabase.from(bank.table).update({ [field.key]: next[field.key] }).eq('id', id);
    if (error) return setMsg(error.message);
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [field.key]: next[field.key] } : r)));
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from(bank.table).delete().eq('id', id);
    if (error) return setMsg(error.message);
    setRows((rs) => rs.filter((r) => r.id !== id));
  };

  const doImport = async () => {
    try {
      const parsed = JSON.parse(json) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)[bank.table];
      if (!Array.isArray(list)) throw new Error(`Expected an array, or an object with a "${bank.table}" array.`);
      const res = await importRows(bank, list, replace);
      setMsg(res);
      setJson('');
      await reload();
    } catch (e) {
      setMsg(errorCode(e));
    }
  };

  const exportJson = () => {
    const clean = rows.map((r) => Object.fromEntries(bank.fields.map((f) => [f.key, r[f.key]])));
    downloadJson(`${bank.table}.json`, clean);
  };

  return (
    <section className="admin-section">
      <p className="dim">{bank.help}</p>
      <div className="row gap wrap">
        <strong>{loading ? '…' : rows.length} rows</strong>
        {hasSecrets && (
          <label className="toggle">
            <input type="checkbox" checked={showSecrets} onChange={(e) => setShowSecrets(e.target.checked)} />
            Show answers (spoilers!)
          </label>
        )}
        <button className="btn btn-sm" onClick={exportJson} disabled={!rows.length}>Export JSON</button>
      </div>
      {msg && (
        <p className="admin-msg" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}

      <div className="card admin-add">
        <h3>Add one</h3>
        <div className="admin-fields">
          {bank.fields.map((f) => (
            <FieldInput key={f.key} field={f} value={draft[f.key] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
          ))}
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => void add()}>Add</button>
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              {bank.fields.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {bank.fields.map((f) => (
                  <td key={f.key}>
                    {f.secret && !showSecrets ? (
                      <span className="dim">••••</span>
                    ) : (
                      <FieldInput
                        field={f}
                        compact
                        value={fieldToString(r[f.key])}
                        onCommit={(v) => void update(r.id, f, v)}
                      />
                    )}
                  </td>
                ))}
                <td>
                  <button className="btn btn-sm btn-ghost" onClick={() => void remove(r.id)} aria-label="Delete row">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card admin-import">
        <h3>Import JSON</h3>
        <p className="dim small">
          An array of objects with keys: <code>{bank.fields.map((f) => f.key).join(', ')}</code>
        </p>
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setJson(await file.text());
          }}
        />
        <textarea className="input mono" rows={8} value={json} onChange={(e) => setJson(e.target.value)} placeholder='[{"text": "..."}]' />
        <div className="row gap">
          <label className="toggle">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace all existing rows
          </label>
          <button className="btn btn-primary btn-sm" disabled={!json.trim()} onClick={() => void doImport()}>Import</button>
        </div>
      </div>
    </section>
  );
}

function fieldToString(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  return v == null ? '' : String(v);
}

function FieldInput({
  field,
  value,
  onChange,
  onCommit,
  compact = false,
}: {
  field: BankField;
  value: string;
  onChange?: (v: string) => void;
  onCommit?: (v: string) => void;
  compact?: boolean;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const set = (v: string) => {
    setLocal(v);
    onChange?.(v);
  };
  const commit = () => {
    if (onCommit && local !== value) onCommit(local);
  };

  if (field.type === 'select') {
    return (
      <label className="field">
        {!compact && <span>{field.label}</span>}
        <select
          className="input"
          value={local || field.options?.[0]}
          onChange={(e) => {
            set(e.target.value);
            onCommit?.(e.target.value);
          }}
        >
          {field.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }
  const Tag = field.type === 'textarea' ? 'textarea' : 'input';
  return (
    <label className="field">
      {!compact && (
        <span>
          {field.label}
          {field.required && ' *'}
        </span>
      )}
      <Tag className="input" value={local} placeholder={field.placeholder} onChange={(e) => set(e.target.value)} onBlur={commit} rows={compact ? 2 : 3} />
    </label>
  );
}

async function importRows(bank: Bank, list: unknown[], replace: boolean): Promise<string> {
  const rows = list.map((r) => cleanRow(bank, r)).filter((r): r is Record<string, unknown> => r !== null);
  const skipped = list.length - rows.length;
  if (replace) {
    const { error } = await supabase.from(bank.table).delete().not('id', 'is', null);
    if (error) throw error;
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(bank.table).insert(rows.slice(i, i + 500));
    if (error) throw error;
  }
  return `${bank.label}: imported ${rows.length}${skipped ? `, skipped ${skipped} invalid` : ''}.`;
}

// ------------------------------------------------------------------ everything
function ImportAll() {
  const [json, setJson] = useState('');
  const [replace, setReplace] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const out: string[] = [];
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      for (const bank of BANKS) {
        const list = parsed[bank.table];
        if (Array.isArray(list)) out.push(await importRows(bank, list, replace));
      }
      if (!out.length) out.push(`No known keys found. Expected any of: ${BANKS.map((b) => b.table).join(', ')}`);
    } catch (e) {
      out.push(`Error: ${errorCode(e)}`);
    }
    setLog(out);
    setBusy(false);
  };

  return (
    <section className="admin-section">
      <p>
        Import a whole seed file at once, e.g. <code>seed/party.json</code> (gitignored). See{' '}
        <code>sample-data/sample-seed.json</code> for the format.
      </p>
      <input
        type="file"
        accept="application/json,.json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) setJson(await file.text());
        }}
      />
      <textarea className="input mono" rows={14} value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"most_likely_prompts": [...], "facts": [...]}' />
      <div className="row gap">
        <label className="toggle">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Replace existing rows in each included bank
        </label>
        <button className="btn btn-primary" disabled={busy || !json.trim()} onClick={() => void run()}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
      {log.length > 0 && (
        <ul className="admin-log">
          {log.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
