import { useEffect, useState } from 'react';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { draw, shuffle } from '../../lib/random';
import { errorCode } from '../../lib/supabase';
import { REASON } from '../reasons';
import { AnonOptions, RevealList, tallyAnonymous, topIds, VoteList, type AnonItem } from '../shared/anon';
import type { GameCtx, GameModule, HostControlsProps, PhoneGameProps, TVGameProps } from '../types';
import { ACRONYM_CONFIG as C } from './config';

/**
 * Acronym Attack. The TV shows random letters; everyone writes a phrase with one word per letter,
 * in order. Anonymous vote (never for your own), then authors are unmasked.
 */

interface Theme {
  id?: string;
  text: string;
}
interface AcronymSettings {
  hard?: boolean;
  themes?: boolean;
  letters?: number; // 0 / undefined = automatic (3 in round 1, 4 afterwards)
}

const FALLBACK_THEMES: Theme[] = [
  { text: 'A very suspicious casserole' },
  { text: 'A terrible slogan for a pizza place' },
  { text: 'What your dog is thinking right now' },
  { text: 'The worst possible parish bulletin headline' },
  { text: 'An unnecessarily dramatic text message' },
  { text: 'The title of a dad\'s autobiography' },
];

const settingsOf = (ctx: { room: { settings: Record<string, unknown> } }) => (ctx.room.settings.acronym ?? {}) as AcronymSettings;

/** Random distinct letters, weighted toward friendly starters. */
function pickLetters(count: number, hard: boolean): string[] {
  const pool: string[] = [];
  for (const l of C.friendlyLetters) for (let i = 0; i < (C.heavyLetters.includes(l) ? 3 : 1); i++) pool.push(l);
  if (hard) pool.push(...C.hardLetters.split(''));
  const out: string[] = [];
  while (out.length < count) {
    const l = pool[Math.floor(Math.random() * pool.length)];
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/** Why a set of words is not a valid acronym for these letters (null = fine). */
export function acronymProblem(words: string[], letters: string[]): string | null {
  if (words.length !== letters.length) return 'Fill in every word.';
  for (let i = 0; i < letters.length; i++) {
    const w = words[i].trim();
    if (!w) return `Word ${i + 1} is empty.`;
    if (w.length > C.maxWordLength) return `Word ${i + 1} is too long.`;
    if (w[0].toUpperCase() !== letters[i]) return `Word ${i + 1} must start with ${letters[i]}.`;
    if (/\s/.test(w)) return `Word ${i + 1} must be a single word.`;
  }
  return null;
}

const textOf = (payload: Record<string, unknown>) => ((payload.words as string[] | undefined) ?? []).map((w) => String(w).trim()).join(' ');

async function startVote(ctx: GameCtx) {
  const letters = ctx.room.state.letters as string[];
  const subs = ctx.roundSubs('acro').filter((s) => textOf(s.payload));
  if (!subs.length) return ctx.endRound();
  if (subs.length === 1) return reveal(ctx);
  const options = shuffle(subs.map((s) => ({ id: s.id, text: textOf(s.payload) })));
  await ctx.setStep('vote', { letters, theme: ctx.room.state.theme ?? null, options }, { seconds: C.voteSeconds, vote: ['acr'] });
}

async function reveal(ctx: GameCtx) {
  const items = tallyAnonymous(ctx, 'acro', 'acr', (p) => textOf(p));
  const winners = topIds(items);
  await ctx.award(
    items.flatMap((it) =>
      it.authorId
        ? [
            { playerId: it.authorId, points: it.votes * C.pointsPerVote, reason: REASON.acroVotes },
            { playerId: it.authorId, points: winners.includes(it.id) ? C.winnerBonus : 0, reason: REASON.acroWin },
          ]
        : [],
    ),
  );
  await ctx.setStep('reveal', { letters: ctx.room.state.letters, theme: ctx.room.state.theme ?? null, items, winners });
}

export const acronymAttack: GameModule = {
  id: 'acronym_attack',
  title: 'Acronym Attack',
  emoji: '🔠',
  tagline: 'Make the letters mean something. Funny wins.',
  rules: [
    'Random letters appear on the TV.',
    'Write a phrase with one word per letter, in order.',
    'Vote for the best one (not your own). Votes and a winner bonus score.',
  ],
  scored: true,
  defaultRounds: C.defaultRounds,
  maxRounds: C.maxRounds,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & Theme>('acronym_themes');
    const deck: Theme[] = rows.length ? leastUsed(rows).map((r) => ({ id: r.id, text: String(r.text) })) : shuffle(FALLBACK_THEMES);
    await ctx.saveRun({ deck, cursor: 0 });
  },

  async startRound(ctx) {
    const s = settingsOf(ctx);
    const auto = ctx.room.round === 1 ? C.firstRoundLetters : C.laterLetters;
    const count = Math.max(C.minLetters, Math.min(C.maxLetters, s.letters || auto));
    const letters = pickLetters(count, Boolean(s.hard));

    let theme: string | null = null;
    if (s.themes !== false) {
      const st = ctx.run.state as { deck?: Theme[]; cursor?: number };
      const d = draw(st.deck?.length ? st.deck : FALLBACK_THEMES, st.cursor ?? 0);
      theme = d.item.text;
      markUsed('acronym_themes', [d.item.id]);
      await ctx.saveRun({ deck: d.deck, cursor: d.cursor, cur: d.item.id ? { table: 'acronym_themes', id: d.item.id } : null });
    }
    await ctx.setStep('write', { letters, theme, rejected: {} }, { seconds: C.writeSeconds, submit: ['acro'] });
  },

  /** Words must start with their letter, in order. Anything else is bounced back with a retry. */
  async process(ctx) {
    if (ctx.room.state.step !== 'write') return;
    const letters = ctx.room.state.letters as string[];
    const bad = ctx.roundSubs('acro').filter((s) => acronymProblem(((s.payload.words as string[]) ?? []).map(String), letters) !== null);
    if (!bad.length) return;
    const prev = (ctx.room.state.rejected ?? {}) as Record<string, number>;
    const rejected = { ...prev };
    for (const b of bad) if (b.player_id) rejected[b.player_id] = (prev[b.player_id] ?? 0) + 1;
    await ctx.removeSubs(bad.map((b) => b.id));
    await ctx.patchState({ rejected });
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'write') return startVote(ctx);
    if (step === 'vote') return reveal(ctx);
    return ctx.endRound();
  },

  ready(ctx) {
    const step = ctx.room.state.step;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (step === 'write') {
      const sent = new Set(ctx.roundSubs('acro').map((s) => s.player_id));
      return active.every((p) => sent.has(p.id));
    }
    if (step === 'vote') {
      const voted = new Set(ctx.roundVotes('acr').map((v) => v.voter_id));
      return active.every((p) => voted.has(p.id));
    }
    return false;
  },

  HostControls: AcronymControls,
  TV: AcronymTV,
  Phone: AcronymPhone,
};

// ---------------------------------------------------------------- host drawer
function AcronymControls({ room, engine }: HostControlsProps) {
  const s = (room.settings.acronym ?? {}) as AcronymSettings;
  const set = (patch: Partial<AcronymSettings>) => void engine.updateSettings({ acronym: { ...s, ...patch } });
  return (
    <div className="stack gap">
      <label className="toggle">
        <input type="checkbox" checked={s.themes !== false} onChange={(e) => set({ themes: e.target.checked })} />
        Show a theme line
      </label>
      <label className="toggle">
        <input type="checkbox" checked={Boolean(s.hard)} onChange={(e) => set({ hard: e.target.checked })} />
        Hard mode (allow Q, V, X, Z)
      </label>
      <label className="field">
        <span>Letters per round</span>
        <select className="team-select" value={s.letters ?? 0} onChange={(e) => set({ letters: Number(e.target.value) })}>
          <option value={0}>Auto ({C.firstRoundLetters} in round 1, then {C.laterLetters})</option>
          {[3, 4, 5].map((n) => (
            <option key={n} value={n}>{n} letters</option>
          ))}
        </select>
      </label>
      <p className="dim small">Changes apply from the next round.</p>
    </div>
  );
}

// ---------------------------------------------------------------- TV
function LetterTiles({ letters }: { letters: string[] }) {
  return (
    <div className="acro-letters">
      {letters.map((l, i) => (
        <span key={i} className="acro-letter pop-in" style={{ animationDelay: `${i * 120}ms` }}>{l}</span>
      ))}
    </div>
  );
}

function AcronymTV({ room, players }: TVGameProps) {
  const step = room.state.step;
  const letters = (room.state.letters as string[]) ?? [];
  const theme = room.state.theme ? String(room.state.theme) : null;
  const done = (room.state.done ?? []).length;

  const header = (
    <>
      {theme && <p className="acro-theme">{theme}</p>}
      <LetterTiles letters={letters} />
    </>
  );

  if (step === 'write') {
    return (
      <div className="center-stack acro-stage">
        {header}
        <p className="lead">One word per letter, in order. Write it on your phone.</p>
        <p className="lead dim">{done} of {players.length} submitted</p>
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    return (
      <div className="center-stack acro-stage">
        {theme && <p className="acro-theme">{theme}</p>}
        <div className="acro-letters acro-letters-small">{letters.join(' · ')}</div>
        <p className="lead dim">Vote for your favorite ({done} of {players.length})</p>
        <AnonOptions options={options} render={(o) => <span className="acro-answer">{o.text}</span>} />
      </div>
    );
  }

  const items = (room.state.items as AnonItem[]) ?? [];
  const winners = (room.state.winners as string[]) ?? [];
  return (
    <div className="center-stack acro-stage">
      {theme && <p className="acro-theme">{theme}</p>}
      <div className="acro-letters acro-letters-small">{letters.join(' · ')}</div>
      <RevealList
        items={items}
        winners={winners}
        players={players}
        label="Best acronym"
        pointsFor={(it, win) => it.votes * C.pointsPerVote + (win ? C.winnerBonus : 0)}
        render={(t) => <span className="acro-answer">{t}</span>}
      />
    </div>
  );
}

// ---------------------------------------------------------------- phone
function AcronymPhone({ room, me, api }: PhoneGameProps) {
  const step = room.state.step;
  const letters = (room.state.letters as string[]) ?? [];
  const theme = room.state.theme ? String(room.state.theme) : null;
  const mine = api.mySubs.find((s) => s.kind === 'acro');
  const [words, setWords] = useState<string[]>(() => letters.map(() => ''));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // New round, new letters: start with empty boxes.
  const lettersKey = letters.join('');
  useEffect(() => setWords(letters.map(() => '')), [lettersKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const bounced = Number((room.state.rejected as Record<string, number> | undefined)?.[me.id] ?? 0);

  if (step === 'write') {
    const padded = letters.map((_, i) => words[i] ?? '');
    const problems = padded.map((w, i) => (w.trim() && w.trim()[0].toUpperCase() !== letters[i] ? `Must start with ${letters[i]}` : null));
    const valid = acronymProblem(padded, letters) === null;
    const send = async () => {
      setBusy(true);
      setErr(null);
      try {
        await api.submit('acro', { words: padded.map((w) => w.trim()) });
      } catch (e) {
        setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Time is up!' : errorCode(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="stack gap">
        {theme && <p className="center acro-theme-phone">{theme}</p>}
        <div className="acro-letters acro-letters-phone">{letters.join(' ')}</div>
        {padded.map((w, i) => (
          <div key={i} className="stack">
            <div className="row gap">
              <span className="acro-letter acro-letter-input">{letters[i]}</span>
              <input
                className="input input-lg"
                value={w}
                maxLength={C.maxWordLength}
                autoCapitalize="words"
                autoComplete="off"
                placeholder={`${letters[i]}…`}
                onChange={(e) => setWords((cur) => padded.map((x, j) => (j === i ? e.target.value.replace(/\s/g, '') : cur[j] ?? x)))}
              />
            </div>
            {problems[i] && <span className="error small">{problems[i]}</span>}
          </div>
        ))}
        <button className="btn btn-primary btn-lg" disabled={busy || !valid} onClick={() => void send()}>
          {mine ? 'Update' : 'Submit'}
        </button>
        {mine && (
          <p className="center dim">
            Sent: <b>{textOf(mine.payload)}</b>. Change it any time before time runs out.
          </p>
        )}
        {!mine && bounced > 0 && <p className="error center">That one didn't fit the letters. Try again.</p>}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    return (
      <div className="stack gap">
        <div className="acro-letters acro-letters-phone">{letters.join(' ')}</div>
        <p className="center dim">Vote for the best one</p>
        <VoteList options={options} mineId={mine?.id} kind="acr" api={api} />
      </div>
    );
  }

  const items = (room.state.items as AnonItem[]) ?? [];
  const winners = (room.state.winners as string[]) ?? [];
  const myItem = items.find((i) => i.authorId === me.id);
  const pts = myItem ? myItem.votes * C.pointsPerVote + (winners.includes(myItem.id) ? C.winnerBonus : 0) : 0;
  return (
    <div className="phone-center center-stack">
      <p className="dim">Winning acronym</p>
      <h2>{items.find((i) => winners.includes(i.id))?.text ?? 'No votes'}</h2>
      {myItem ? <p className="points big-num">+{pts}</p> : <p className="dim">You did not submit this round.</p>}
    </div>
  );
}
