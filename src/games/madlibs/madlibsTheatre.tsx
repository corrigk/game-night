import { useEffect, useRef, useState } from 'react';
import { useNow } from '../../components/Countdown';
import { PlayerChip } from '../../components/PlayerChip';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { secondsLeft, serverNow } from '../../lib/clock';
import { shuffle } from '../../lib/random';
import { isMuted } from '../../lib/sound';
import { errorCode, supabase } from '../../lib/supabase';
import type { GameCtx, GameModule, HostControlsProps, PhoneGameProps, TVGameProps } from '../types';
import { MADLIBS_CONFIG as C } from './config';

/**
 * Mad Libs Theatre (no scoring, no voting). Everyone fills in blanks for a secret script, a small
 * cast performs it, and the audience watches.
 *
 * Secrecy is enforced at the data layer, not just in the UI:
 *  - The full script lives only in game_runs.state (host-only RLS).
 *  - Fill phase: each player gets a private 'blanks' row with ONLY their blanks' prompts.
 *  - Performance: each cast member gets a private 'role' row with ONLY their own lines (plus the line
 *    before each as a cue). RLS lets a phone read only its own rows, so audience phones and other cast
 *    members cannot read anyone else's lines.
 *  - Public room state during the show holds only the title, cast list, and which role is up. The TV
 *    never shows script text until the optional finale.
 */

interface Role {
  name: string;
  color: string;
}
interface Blank {
  id: string;
  prompt?: string;
  kind: 'free' | 'roster';
}
interface Line {
  role: string;
  text: string;
  direction?: string;
}
interface Template {
  dbId?: string;
  slug: string;
  title: string;
  description?: string;
  roles: Role[];
  blanks: Blank[];
  lines: Line[];
}
interface Fill {
  word: string;
  by: string | null;
}
interface RunState {
  all?: Template[];
  queue?: string[];
  played?: string[];
  template?: Template;
  assign?: Record<string, string[]>;
  fills?: Record<string, Fill>;
  cast?: Record<string, string>;
  performed?: string[];
}
interface CastEntry {
  role: string;
  color: string;
  playerId: string;
}
type Seg = { t: string } | { w: string; by: string | null };

const PH = /\{\{\s*([^}\s]+)\s*\}\}/g;

const BUILTIN: Template = {
  slug: 'builtin-sandwich',
  title: 'The Great Sandwich Heist',
  description: 'A very small crime in a very large kitchen.',
  roles: [
    { name: 'Detective', color: '#0984e3' },
    { name: 'Suspect', color: '#e17055' },
    { name: 'Narrator', color: '#6c5ce7' },
  ],
  blanks: [
    { id: 'b1', prompt: 'A sandwich filling', kind: 'free' },
    { id: 'b2', prompt: 'A dramatic adjective', kind: 'free' },
    { id: 'b3', prompt: 'A friend\'s name', kind: 'roster' },
    { id: 'b4', prompt: 'A weird place to hide a sandwich', kind: 'free' },
    { id: 'b5', prompt: 'A silly noise', kind: 'free' },
    { id: 'b6', prompt: 'A bad alibi', kind: 'free' },
  ],
  lines: [
    { role: 'Narrator', text: 'It was a {{b2}} night in the kitchen, and the {{b1}} sandwich was gone.', direction: '(whispers into an imaginary microphone)' },
    { role: 'Detective', text: 'Only one person could have done this. {{b3}}!' },
    { role: 'Suspect', text: 'I was nowhere near it. I was {{b6}}.' },
    { role: 'Detective', text: 'Then explain the crumbs leading to the {{b4}}.' },
    { role: 'Suspect', text: '{{b5}}!', direction: '(gasps and clutches chest)' },
    { role: 'Narrator', text: 'And so the {{b2}} case of the {{b1}} sandwich was closed.', direction: '(takes a bow)' },
  ],
};

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, C.maxWordLength);
const placeholder = () => C.placeholders[Math.floor(Math.random() * C.placeholders.length)];
const fillText = (text: string, fills: Record<string, Fill>) => text.replace(PH, (_, id) => fills[id]?.word ?? '???');

function toSegs(text: string, fills: Record<string, Fill>): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(PH)) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    const f = fills[m[1]];
    out.push({ w: f?.word ?? '???', by: f?.by ?? null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

const st = (ctx: GameCtx) => ctx.run.state as RunState;
const castList = (t: Template, cast: Record<string, string>): CastEntry[] =>
  t.roles.map((r) => ({ role: r.name, color: r.color, playerId: cast[r.name] }));
const settingOn = (ctx: GameCtx, key: string, dflt: boolean) => (ctx.room.settings[key] === undefined ? dflt : Boolean(ctx.room.settings[key]));

// ---------------------------------------------------------------- flow
async function pickStep(ctx: GameCtx) {
  const s = st(ctx);
  const played = s.played ?? [];
  await ctx.setStep('pick', {
    options: (s.all ?? []).map((t) => ({ slug: t.slug, title: t.title, description: t.description ?? '', roles: t.roles.length, played: played.includes(t.slug) })),
    hideStrip: true,
  });
}

function randomSlug(ctx: GameCtx): string {
  const s = st(ctx);
  const all = s.all ?? [];
  const fresh = all.filter((t) => !(s.played ?? []).includes(t.slug));
  return shuffle(fresh.length ? fresh : all)[0].slug;
}

async function startScript(ctx: GameCtx, slug: string) {
  const s = st(ctx);
  const t = (s.all ?? []).find((x) => x.slug === slug) ?? (s.all ?? [])[0];
  const useNames = settingOn(ctx, 'madlibsUseNames', true);
  const players = ctx.players;

  // Roster blanks are filled with player names (distinct where possible); the rest are dealt out.
  const fills: Record<string, Fill> = {};
  const names = shuffle(players.map((p) => p.name));
  t.blanks
    .filter((b) => b.kind === 'roster' && useNames)
    .forEach((b, i) => {
      fills[b.id] = { word: names[i % Math.max(1, names.length)] ?? 'Someone', by: null };
    });
  const free = shuffle(t.blanks.filter((b) => b.kind === 'free' || !useNames));
  const order = shuffle(players);
  const assign: Record<string, string[]> = {};
  free.forEach((b, i) => {
    const p = order[i % order.length];
    (assign[p.id] ??= []).push(b.id);
  });

  const promptOf = (id: string) => t.blanks.find((b) => b.id === id)?.prompt || (t.blanks.find((b) => b.id === id)?.kind === 'roster' ? "A friend's name" : 'A word');
  await ctx.saveRun({ template: t, assign, fills, cast: null, played: [...new Set([...(s.played ?? []), t.slug])] });
  markUsed('madlibs_templates', [t.dbId]);
  await ctx.addSubs(
    Object.entries(assign).map(([pid, ids]) => ({ kind: 'blanks', player_id: pid, payload: { title: t.title, items: ids.map((id) => ({ id, prompt: promptOf(id) })) } })),
  );
  await ctx.setStep('fill', { title: t.title }, { seconds: C.fillSeconds, submit: ['fill'] });
}

async function collectFills(ctx: GameCtx) {
  const s = st(ctx);
  const fills = { ...(s.fills ?? {}) };
  const subs = ctx.roundSubs('fill');
  for (const [pid, ids] of Object.entries(s.assign ?? {})) {
    const answers = (subs.find((x) => x.player_id === pid)?.payload.answers ?? {}) as Record<string, unknown>;
    for (const id of ids) {
      const word = clean(answers[id]);
      fills[id] = { word: word || placeholder(), by: word ? pid : null };
    }
  }
  await ctx.saveRun({ fills });
  await ctx.setStep('cast', { title: s.template!.title, roles: s.template!.roles });
}

/** Pick who plays each role. Volunteers first, then players who haven't performed yet, then the rest. */
async function castRoles(ctx: GameCtx, volunteers: string[] = [], explicit: Record<string, string> = {}) {
  const s = st(ctx);
  const t = s.template!;
  const here = new Set(ctx.players.map((p) => p.id));
  const performed = new Set(s.performed ?? []);
  const cast: Record<string, string> = {};
  for (const r of t.roles) if (explicit[r.name] && here.has(explicit[r.name])) cast[r.name] = explicit[r.name];

  const unperformed = shuffle(ctx.players.filter((p) => !performed.has(p.id)).map((p) => p.id));
  const performedBefore = shuffle(ctx.players.filter((p) => performed.has(p.id)).map((p) => p.id));
  const vols = shuffle(volunteers.filter((id) => here.has(id))).sort((a, b) => Number(performed.has(a)) - Number(performed.has(b)));
  const used = new Set(Object.values(cast));
  const order = [...new Set([...vols, ...unperformed, ...performedBefore])].filter((id) => !used.has(id));

  const open = shuffle(t.roles.map((r) => r.name).filter((n) => !cast[n]));
  open.forEach((role, i) => {
    cast[role] = order[i] ?? order[i % Math.max(1, order.length)] ?? [...used][0] ?? ctx.players[0].id; // fewer players than roles: some double up
  });
  await startCurtain(ctx, cast);
}

/** Write each cast member's private role sheet, then raise the curtain. */
async function startCurtain(ctx: GameCtx, cast: Record<string, string>) {
  const s = st(ctx);
  const t = s.template!;
  const fills = s.fills ?? {};
  const rendered = t.lines.map((l) => ({ ...l, text: fillText(l.text, fills) }));

  const byPlayer = new Map<string, { roles: Role[]; items: Record<string, unknown>[] }>();
  rendered.forEach((l, i) => {
    const pid = cast[l.role];
    if (!pid) return;
    const sheet = byPlayer.get(pid) ?? { roles: [], items: [] };
    const role = t.roles.find((r) => r.name === l.role)!;
    if (!sheet.roles.some((r) => r.name === role.name)) sheet.roles.push(role);
    const prev = rendered[i - 1];
    sheet.items.push({ i, role: l.role, color: role.color, text: l.text, direction: l.direction ?? null, cue: prev ? { role: prev.role, text: prev.text } : null });
    byPlayer.set(pid, sheet);
  });

  const old = ctx.roundSubs('role').map((x) => x.id);
  if (old.length) await ctx.removeSubs(old);
  await ctx.saveRun({ cast, performed: [...new Set([...(s.performed ?? []), ...Object.values(cast)])] });
  await ctx.addSubs([...byPlayer].map(([pid, sheet]) => ({ kind: 'role', player_id: pid, payload: { title: t.title, roles: sheet.roles, items: sheet.items } })));
  await ctx.setStep('curtain', { title: t.title, cast: castList(t, cast), total: t.lines.length, hideStrip: true }, { seconds: C.curtainSeconds });
}

const lineInfo = (ctx: GameCtx, n: number) => {
  const s = st(ctx);
  const line = s.template!.lines[n];
  return { n, lineRole: line.role, linePlayerId: s.cast?.[line.role] ?? null, lineAt: serverNow() };
};

async function startPerform(ctx: GameCtx) {
  const s = st(ctx);
  const t = s.template!;
  await ctx.setStep('perform', { title: t.title, cast: castList(t, s.cast ?? {}), total: t.lines.length, hideStrip: true, ...lineInfo(ctx, 0) }, { submit: ['done'], count: [] });
}

async function advance(ctx: GameCtx, delta: number) {
  const total = st(ctx).template!.lines.length;
  const n = Number(ctx.room.state.n ?? 0) + delta;
  if (n >= total) return afterShow(ctx);
  await ctx.patchState(lineInfo(ctx, Math.max(0, n)));
}

async function afterShow(ctx: GameCtx) {
  if (settingOn(ctx, 'madlibsFinale', true)) return showFinale(ctx, 1);
  return ctx.endRound();
}

async function showFinale(ctx: GameCtx, shown: number) {
  const s = st(ctx);
  const t = s.template!;
  const fills = s.fills ?? {};
  const cast = s.cast ?? {};
  const lines = t.lines.map((l) => ({
    role: l.role,
    color: t.roles.find((r) => r.name === l.role)?.color ?? '#999999',
    playerId: cast[l.role] ?? null,
    direction: l.direction ?? null,
    segs: toSegs(l.text, fills),
  }));
  const done = shown >= lines.length;
  const last = t.lines[Math.min(shown, lines.length) - 1];
  const secs = Math.round(Math.min(C.finaleMaxSeconds, Math.max(C.finaleMinSeconds, fillText(last.text, fills).length / C.finaleCharsPerSecond)));
  await ctx.setStep('finale', { title: t.title, lines, total: lines.length, shown: Math.min(shown, lines.length), done, hideStrip: true }, done ? {} : { seconds: secs });
}

export const madlibsTheatre: GameModule = {
  id: 'madlibs_theatre',
  title: 'Mad Libs Theatre',
  emoji: '🎭',
  tagline: 'Everyone writes the words. A few brave souls perform them.',
  rules: [
    'Everyone fills in a few secret blanks on their phone.',
    'A small cast performs the finished script live. Nobody sees it until they say it.',
    'Everyone else is the audience. No points, just a show.',
  ],
  scored: false,
  defaultRounds: C.defaultRounds,
  maxRounds: C.maxRounds,
  status: 'ready',
  progressLabel: (room) => `Script ${room.round}/${room.rounds_total}`,

  async setup(ctx) {
    const rows = await loadBank<BankRow & Record<string, unknown>>('madlibs_templates');
    const all: Template[] = leastUsed(rows)
      .filter((r) => r.mode !== 'story')
      .map((r) => ({
        dbId: r.id,
        slug: String(r.slug ?? r.id),
        title: String(r.title),
        description: String(r.description ?? ''),
        roles: (r.roles as Role[]) ?? [],
        blanks: (r.blanks as Blank[]) ?? [],
        lines: (r.lines as Line[]) ?? [],
      }))
      .filter((t) => t.roles.length && t.lines.length);

    // Scripts already played tonight, across every Mad Libs run in this room.
    const { data } = await supabase.from('game_runs').select('state').eq('room_id', ctx.room.id).eq('game_type', 'madlibs_theatre');
    const played = new Set<string>();
    for (const r of data ?? []) for (const slug of ((r.state as RunState).played ?? [])) played.add(slug);

    await ctx.saveRun({ all: all.length ? all : [BUILTIN], queue: [], played: [...played], performed: [] });
  },

  async startRound(ctx) {
    const queue = [...(st(ctx).queue ?? [])];
    if (queue.length) {
      const slug = queue.shift()!;
      await ctx.saveRun({ queue });
      return startScript(ctx, slug);
    }
    return pickStep(ctx);
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'pick') return startScript(ctx, randomSlug(ctx));
    if (step === 'fill') return collectFills(ctx);
    if (step === 'cast') return castRoles(ctx);
    if (step === 'volunteer') return castRoles(ctx, ctx.roundSubs('volunteer').map((x) => x.player_id!).filter(Boolean));
    if (step === 'curtain') return startPerform(ctx);
    if (step === 'perform') return advance(ctx, 1);
    if (step === 'finale') return ctx.room.state.done ? ctx.endRound() : showFinale(ctx, Number(ctx.room.state.shown ?? 1) + 1);
    return ctx.endRound();
  },

  /** Skip: pick for me / move on / next line. */
  async skip(ctx) {
    return this.next(ctx);
  },

  /** The performer who just finished can tap Done to move the show along. */
  async process(ctx) {
    if (!C.doneOverride || ctx.room.state.step !== 'perform') return;
    const n = Number(ctx.room.state.n ?? 0);
    const performer = String(ctx.room.state.linePlayerId ?? '');
    // Only taps made after this line came up count (so "Back a line" can't replay an old Done).
    const since = Number(ctx.room.state.lineAt ?? 0) - 300;
    const tapped = ctx.roundSubs('done').some((s) => s.player_id === performer && Number(s.payload.n) === n && Date.parse(s.updated_at) >= since);
    if (tapped) await advance(ctx, 1);
  },

  ready(ctx) {
    if (ctx.room.state.step !== 'fill') return false;
    const assign = st(ctx).assign ?? {};
    const sent = new Set(ctx.roundSubs('fill').map((s) => s.player_id));
    const need = ctx.players.filter((p) => assign[p.id] && p.connected);
    return need.length > 0 && need.every((p) => sent.has(p.id));
  },

  async action(ctx, name, payload) {
    const step = ctx.room.state.step;
    if (name === 'pick' && step === 'pick') return startScript(ctx, payload.slug ? String(payload.slug) : randomSlug(ctx));
    if (name === 'queue' && payload.slug) return ctx.saveRun({ queue: [...(st(ctx).queue ?? []), String(payload.slug)] });
    if (name === 'clearQueue') return ctx.saveRun({ queue: [] });
    if (name === 'castRandom' && (step === 'cast' || step === 'volunteer')) return castRoles(ctx);
    if (name === 'castVolunteers' && step === 'cast') {
      const t = st(ctx).template!;
      return ctx.setStep('volunteer', { title: t.title, roles: t.roles, hideStrip: true }, { seconds: C.volunteerSeconds, submit: ['volunteer'] });
    }
    if (name === 'castPick' && (step === 'cast' || step === 'volunteer')) return castRoles(ctx, [], (payload.assign ?? {}) as Record<string, string>);
    if (name === 'back' && step === 'perform') return advance(ctx, -1);
  },

  HostControls: MadlibsControls,
  TV: MadlibsTV,
  Phone: MadlibsPhone,
};

// ---------------------------------------------------------------- host drawer
function MadlibsControls({ room, players, run, engine }: HostControlsProps) {
  const s = (run?.state ?? {}) as RunState;
  const step = room.state.step;
  const roles = s.template?.roles ?? [];
  const [slug, setSlug] = useState('');
  const [assign, setAssign] = useState<Record<string, string>>({});
  const flag = (key: string, dflt: boolean) => (room.settings[key] === undefined ? dflt : Boolean(room.settings[key]));
  const queued = (s.queue ?? []).map((q) => (s.all ?? []).find((t) => t.slug === q)?.title ?? q);

  return (
    <div className="stack gap">
      <label className="toggle">
        <input type="checkbox" checked={flag('madlibsUseNames', true)} onChange={(e) => void engine.updateSettings({ madlibsUseNames: e.target.checked })} />
        Use player names
      </label>
      <label className="toggle">
        <input type="checkbox" checked={flag('madlibsFinale', true)} onChange={(e) => void engine.updateSettings({ madlibsFinale: e.target.checked })} />
        Finale: reveal the finished script
      </label>
      <label className="toggle">
        <input type="checkbox" checked={flag('madlibsNarrator', false)} onChange={(e) => void engine.updateSettings({ madlibsNarrator: e.target.checked })} />
        Narrator reads the finale aloud (needs sound on)
      </label>

      <div className="stack gap">
        <strong>Script queue</strong>
        {queued.length > 0 ? <ol className="small">{queued.map((q, i) => <li key={i}>{q}</li>)}</ol> : <p className="dim small">Empty. You'll choose at the start of each script.</p>}
        <div className="row gap">
          <select className="team-select grow" value={slug} onChange={(e) => setSlug(e.target.value)}>
            <option value="">Add a script…</option>
            {(s.all ?? []).map((t) => (
              <option key={t.slug} value={t.slug}>{t.title}{(s.played ?? []).includes(t.slug) ? ' (played)' : ''}</option>
            ))}
          </select>
          <button className="btn btn-sm" disabled={!slug} onClick={() => { void engine.gameAction('queue', { slug }); setSlug(''); }}>Queue</button>
        </div>
        {queued.length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => void engine.gameAction('clearQueue')}>Clear queue</button>}
      </div>

      {(step === 'cast' || step === 'volunteer') && (
        <div className="stack gap">
          <strong>Casting</strong>
          <div className="drawer-grid">
            <button className="btn btn-primary" onClick={() => void engine.gameAction('castRandom')}>🎲 Random</button>
            <button className="btn" disabled={step !== 'cast'} onClick={() => void engine.gameAction('castVolunteers')}>🙋 Volunteers ({C.volunteerSeconds}s)</button>
          </div>
          <p className="dim small">Or pick who plays each role:</p>
          {roles.map((r) => (
            <label key={r.name} className="row gap">
              <span className="grow" style={{ color: r.color, fontWeight: 800 }}>{r.name}</span>
              <select className="team-select" value={assign[r.name] ?? ''} onChange={(e) => setAssign((a) => ({ ...a, [r.name]: e.target.value }))}>
                <option value="">random</option>
                {players.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          ))}
          <button className="btn btn-sm" onClick={() => void engine.gameAction('castPick', { assign })}>Confirm cast</button>
        </div>
      )}

      {step === 'perform' && (
        <div className="drawer-grid">
          <button className="btn" onClick={() => void engine.gameAction('back')}>◀ Back a line</button>
          <button className="btn btn-primary" onClick={() => void engine.next()}>Next line ▶ <kbd>Space</kbd></button>
        </div>
      )}
      <p className="dim small">Pause the show with <kbd>P</kbd>. Skip prompt moves things along.</p>
    </div>
  );
}

// ---------------------------------------------------------------- TV
function BigCount({ endsAt }: { endsAt: string | null }) {
  useNow(100);
  const left = Math.ceil(secondsLeft(endsAt) ?? 0);
  return <div className="dolphin-timer">{left > 0 ? left : '🎬'}</div>;
}

function CastBoard({ cast, players, activeRole }: { cast: CastEntry[]; players: TVGameProps['players']; activeRole?: string }) {
  const map = new Map(players.map((p) => [p.id, p]));
  return (
    <div className="ml-cast">
      {cast.map((c) => {
        const p = map.get(c.playerId);
        return (
          <div key={c.role} className={`ml-cast-card${c.role === activeRole ? ' ml-cast-active' : ''}`} style={{ ['--rc' as string]: c.color }}>
            <div className="ml-role">{c.role}</div>
            {p ? <PlayerChip player={p} size="md" /> : <span className="dim">—</span>}
          </div>
        );
      })}
    </div>
  );
}

function MadlibsTV({ room, players, subs, engine }: TVGameProps) {
  const step = room.state.step;
  const title = String(room.state.title ?? '');
  const done = (room.state.done ?? []).length;
  const cast = (room.state.cast as CastEntry[]) ?? [];
  const map = new Map(players.map((p) => [p.id, p]));

  // Narrator: read each newly revealed finale line aloud (only when sound is on).
  const narrator = Boolean(room.settings.madlibsNarrator);
  const lines = (room.state.lines as { role: string; segs: Seg[] }[]) ?? [];
  const shown = Number(room.state.shown ?? 0);
  useEffect(() => {
    if (step !== 'finale' || !narrator || isMuted() || !('speechSynthesis' in window)) return;
    const l = lines[shown - 1];
    if (!l) return;
    const spoken = l.segs.map((g) => ('t' in g ? g.t : g.w)).join('');
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(`${l.role}. ${spoken}`));
    return () => window.speechSynthesis.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, shown, narrator]);

  if (step === 'pick') {
    const options = (room.state.options as { slug: string; title: string; description: string; roles: number; played: boolean }[]) ?? [];
    return (
      <div className="center-stack ml-stage">
        <h1 className="display">Choose a script</h1>
        <div className="ml-scripts">
          {options.map((o) => (
            <button key={o.slug} className={`ml-script${o.played ? ' ml-script-played' : ''}`} onClick={() => void engine.gameAction('pick', { slug: o.slug })}>
              <b>{o.title}</b>
              <span>{o.description}</span>
              <small>{o.roles} roles{o.played ? ' · played tonight' : ''}</small>
            </button>
          ))}
        </div>
        <button className="btn btn-lg" onClick={() => void engine.gameAction('pick', {})}>🎲 Surprise me <kbd>Space</kbd></button>
      </div>
    );
  }

  if (step === 'fill') {
    return (
      <div className="center-stack ml-stage">
        <h1 className="display">{title}</h1>
        <p className="lead">Fill in your secret words on your phone. You won't see the script. Nobody will, until it's performed.</p>
        <p className="lead dim">{done} of {players.length} done</p>
      </div>
    );
  }

  if (step === 'cast') {
    const roles = (room.state.roles as Role[]) ?? [];
    return (
      <div className="center-stack ml-stage">
        <h1 className="display">Casting: {title}</h1>
        <div className="ml-cast">
          {roles.map((r) => (
            <div key={r.name} className="ml-cast-card" style={{ ['--rc' as string]: r.color }}>
              <div className="ml-role">{r.name}</div>
            </div>
          ))}
        </div>
        <div className="row gap center wrap">
          <button className="btn btn-lg btn-primary" onClick={() => void engine.gameAction('castRandom')}>🎲 Random</button>
          <button className="btn btn-lg" onClick={() => void engine.gameAction('castVolunteers')}>🙋 Volunteers</button>
        </div>
        <p className="dim">Or pick the cast yourself in the host drawer (<kbd>H</kbd>). <kbd>Space</kbd> = random.</p>
      </div>
    );
  }

  if (step === 'volunteer') {
    const roles = (room.state.roles as Role[]) ?? [];
    const vols = subs.filter((s) => s.round === room.round && s.kind === 'volunteer');
    return (
      <div className="center-stack ml-stage">
        <h1 className="display">Who wants to perform?</h1>
        <p className="lead">{roles.length} role{roles.length === 1 ? '' : 's'}: {roles.map((r) => r.name).join(', ')}</p>
        <p className="lead">Tap "I want to perform" on your phone!</p>
        <div className="row gap center wrap">
          {vols.map((v) => {
            const p = v.player_id ? map.get(v.player_id) : null;
            return p ? <PlayerChip key={v.id} player={p} size="lg" /> : null;
          })}
        </div>
      </div>
    );
  }

  if (step === 'curtain') {
    return (
      <div className="center-stack ml-stage">
        <h1 className="display huge title-glow">Curtain up!</h1>
        <BigCount endsAt={room.timer_ends_at} />
        <CastBoard cast={cast} players={players} />
      </div>
    );
  }

  if (step === 'perform') {
    const n = Number(room.state.n ?? 0);
    const total = Number(room.state.total ?? 1);
    const role = String(room.state.lineRole ?? '');
    const performer = map.get(String(room.state.linePlayerId ?? ''));
    const roleColor = cast.find((c) => c.role === role)?.color;
    return (
      <div className="center-stack ml-stage">
        <h1 className="display">{title}</h1>
        <CastBoard cast={cast} players={players} activeRole={role} />
        <div className="ml-now" style={{ ['--rc' as string]: roleColor }}>
          <span className="dim">Now performing</span>
          <b>{role}</b>
          {performer && <PlayerChip player={performer} size="lg" />}
        </div>
        <div className="ml-progress" aria-label={`Line ${n + 1} of ${total}`}>
          <i style={{ width: `${((n + 1) / total) * 100}%` }} />
        </div>
        <p className="lead dim">Line {n + 1} of {total} · <kbd>Space</kbd> next line</p>
      </div>
    );
  }

  // finale
  const credits = new Map<string, number>();
  for (const l of lines) for (const g of l.segs) if ('w' in g && g.by) credits.set(g.by, (credits.get(g.by) ?? 0) + 1);
  return <Finale title={title} lines={lines as FinaleLine[]} shown={shown} done={Boolean(room.state.done)} map={map} credits={credits} />;
}

interface FinaleLine {
  role: string;
  color: string;
  playerId: string | null;
  direction: string | null;
  segs: Seg[];
}

function Finale({ title, lines, shown, done, map, credits }: { title: string; lines: FinaleLine[]; shown: number; done: boolean; map: Map<string, TVGameProps['players'][number]>; credits: Map<string, number> }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [shown, done]);
  return (
    <div className="ml-finale">
      <h1 className="display">{title}</h1>
      <div className="ml-script-scroll">
        {lines.slice(0, shown).map((l, i) => (
          <div key={i} className="ml-fline pop-in" style={{ ['--rc' as string]: l.color }}>
            <span className="ml-frole">{l.role}</span>
            {l.direction && <i className="ml-fdir">{l.direction}</i>}
            <p>
              {l.segs.map((g, j) =>
                'w' in g ? (
                  <mark key={j} className="ml-word" style={g.by && map.get(g.by) ? { background: map.get(g.by)!.color, color: '#111' } : undefined}>{g.w}</mark>
                ) : (
                  <span key={j}>{g.t}</span>
                ),
              )}
            </p>
          </div>
        ))}
        {done && (
          <div className="ml-credits pop-in">
            <h2>Words by</h2>
            <div className="row gap center wrap">
              {[...credits].map(([id, n]) => (map.get(id) ? <span key={id}><PlayerChip player={map.get(id)!} size="md" /> <span className="dim">×{n}</span></span> : null))}
            </div>
            <p className="tv-footer"><kbd>Space</kbd> to finish</p>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- phone
function MadlibsPhone({ room, me, api }: PhoneGameProps) {
  const step = room.state.step;
  const [err, setErr] = useState<string | null>(null);
  const role = api.mySubs.find((s) => s.kind === 'role');
  const volunteered = api.mySubs.some((s) => s.kind === 'volunteer');

  if (step === 'pick') return <Centered title="Choosing a script…" body="The host is picking tonight's show." />;
  if (step === 'fill') return <FillForm api={api} />;
  if (step === 'cast') return <Centered title="Casting…" body="Watch the TV. The host is choosing who performs." />;

  if (step === 'volunteer') {
    return (
      <div className="phone-center center-stack">
        <h1 className="display phone-title">🙋 Want a part?</h1>
        <button
          className="btn btn-primary btn-lg"
          disabled={volunteered}
          onClick={() => api.submit('volunteer', {}).catch((e) => setErr(errorCode(e)))}
        >
          {volunteered ? "✓ You're on the list" : 'I want to perform'}
        </button>
        {err && <p className="error">{err}</p>}
      </div>
    );
  }

  const myRoles = (role?.payload.roles as Role[] | undefined) ?? [];
  if (step === 'curtain') {
    return myRoles.length ? (
      <div className="phone-center center-stack">
        <h1 className="display phone-title">You're {myRoles.map((r) => r.name).join(' & ')}!</h1>
        <p className="lead">Curtain up in a moment. Your lines will appear here.</p>
      </div>
    ) : (
      <Centered title="🎬 Curtain up!" body="You're in the audience. Watch the show!" />
    );
  }

  if (step === 'perform') {
    return myRoles.length ? <Prompter room={room} api={api} role={role!} /> : <Centered title="🍿 Watch the show!" body="Eyes on the stage." />;
  }

  return (
    <Centered
      title="🎭 Encore!"
      body={`Look at the TV to see the finished script${me.name ? `, ${me.name}` : ''}. Your words are highlighted in your color.`}
    />
  );
}

function Centered({ title, body }: { title: string; body: string }) {
  return (
    <div className="phone-center center-stack">
      <h1 className="display phone-title">{title}</h1>
      <p className="lead">{body}</p>
    </div>
  );
}

function FillForm({ api }: Pick<PhoneGameProps, 'api'>) {
  const row = api.mySubs.find((s) => s.kind === 'blanks');
  const items = (row?.payload.items as { id: string; prompt: string }[] | undefined) ?? [];
  const mine = api.mySubs.find((s) => s.kind === 'fill');
  const saved = (mine?.payload.answers ?? {}) as Record<string, string>;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = (id: string) => answers[id] ?? saved[id] ?? '';

  if (!row) {
    return <Centered title="No words for you" body="Sit tight. You'll get the whole show soon." />;
  }

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.submit('fill', { answers: Object.fromEntries(items.map((i) => [i.id, value(i.id).trim()])) });
    } catch (e) {
      setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Time is up!' : errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap">
      <h2 className="center">✍️ Fill in the blanks</h2>
      <p className="center dim">Be funny. You won't see the script.</p>
      {items.map((it) => (
        <label key={it.id} className="field">
          <span>{it.prompt}</span>
          <input
            className="input input-lg"
            value={value(it.id)}
            maxLength={C.maxWordLength}
            autoComplete="off"
            onChange={(e) => setAnswers((a) => ({ ...a, [it.id]: e.target.value }))}
          />
        </label>
      ))}
      <button className="btn btn-primary btn-lg" disabled={busy || items.some((i) => !value(i.id).trim())} onClick={() => void send()}>
        {mine ? 'Update' : 'Submit'}
      </button>
      {mine && <p className="center dim">Sent! You can change them until time runs out.</p>}
      {err && <p className="error center">{err}</p>}
    </div>
  );
}

/** A cast member's private prompter: only their own lines, the cue before each, current line highlighted. */
function Prompter({ room, api, role }: { room: PhoneGameProps['room']; api: PhoneGameProps['api']; role: PhoneGameProps['api']['mySubs'][number] }) {
  const items = (role.payload.items as {
    i: number; role: string; color: string; text: string; direction: string | null; cue: { role: string; text: string } | null;
  }[]) ?? [];
  const n = Number(room.state.n ?? 0);
  const myTurn = items.some((it) => it.i === n);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    document.getElementById(`ml-line-${items.find((it) => it.i >= n)?.i ?? ''}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [n, items]);

  return (
    <div className="stack gap ml-prompter">
      <p className="center dim">Line {n + 1} of {Number(room.state.total ?? 0)}</p>
      {items.map((it) => {
        const current = it.i === n;
        const past = it.i < n;
        return (
          <div key={it.i} id={`ml-line-${it.i}`} className={`ml-pline${current ? ' ml-pline-current' : ''}${past ? ' ml-pline-past' : ''}`} style={{ ['--rc' as string]: it.color }}>
            {it.cue && <div className="ml-cue"><span>Cue · {it.cue.role}:</span> {it.cue.text}</div>}
            <div className="ml-pname">{it.role}</div>
            {it.direction && <div className="ml-pdir">{it.direction}</div>}
            <div className="ml-ptext">{it.text}</div>
          </div>
        );
      })}
      {myTurn && (
        <button
          className="btn btn-primary btn-lg sticky-bottom"
          onClick={() => api.submit('done', { n }).catch((e) => setErr(errorCode(e)))}
        >
          ✓ Done
        </button>
      )}
      {err && <p className="error center">{err}</p>}
    </div>
  );
}
