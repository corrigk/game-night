import { useRef, useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { downscale, randomId } from '../../lib/image';
import { draw, shuffle } from '../../lib/random';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { errorCode, supabase } from '../../lib/supabase';
import type { Player, Submission } from '../../lib/types';
import { REASON } from '../reasons';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';

/**
 * Zillow Hunt (individual). Nothing is scraped or embedded: players search Zillow in their own
 * browser, then submit a listing URL plus 1-3 screenshots (private `zillow-screenshots` bucket).
 * Flow per round: announce → search → submit → gallery vote → top 3 → pitches → final vote → reveal.
 * On "filter" rounds, players can "Call it out" and the host rules from the TV.
 */

const SEARCH_SECONDS = 240;
const SUBMIT_SECONDS = 75;
const GALLERY_SECONDS = 75;
const PITCH_SECONDS = 45;
const FINAL_SECONDS = 30;
const GALLERY_VOTE_POINTS = 50;
const FINAL_POINTS = [400, 200, 100];

interface Info {
  type: 'wildcard' | 'filter' | 'weird';
  headline: string;
  location: string;
  filters: string[];
}
interface Finalist {
  id: string;
  authorId: string | null;
  url: string;
  shots: string[];
  count: number;
}
interface Entry {
  id: string;
  label: number;
  shots: string[];
}
interface Result extends Finalist {
  points: number;
}
interface PromptRow {
  id?: string;
  type: Info['type'];
  location: string;
  prompt: string | null;
  filters: string[] | null;
}

const FALLBACK: PromptRow[] = [
  { type: 'wildcard', location: 'Boise, Idaho', prompt: null, filters: [] },
  { type: 'filter', location: 'Ohio', prompt: null, filters: ['Under $250,000', 'Has a pool'] },
  { type: 'weird', location: 'Anywhere in the US', prompt: null, filters: ['Most haunted-looking house'] },
];

function buildInfo(r: PromptRow): Info {
  const filters = (r.filters ?? []).filter(Boolean);
  if (r.type === 'weird') {
    return { type: 'weird', headline: filters[0] ?? r.prompt ?? 'Find something weird', location: r.location, filters: filters.slice(1) };
  }
  if (r.type === 'filter') {
    return { type: 'filter', headline: r.prompt ?? `Find a house in ${r.location}`, location: r.location, filters };
  }
  return { type: 'wildcard', headline: r.prompt ? `${r.prompt} in ${r.location}` : `Find the coolest listing in ${r.location}`, location: r.location, filters: [] };
}

const infoOf = (ctx: GameCtx) => ctx.room.state.info as Info;
const dqOf = (ctx: GameCtx) => ((ctx.run.state as { dq?: string[] }).dq ?? []) as string[];
const challengeKinds = (info: Info) => (info.type === 'filter' ? ['challenge'] : []);

const validListing = (s: Submission) => {
  const url = String(s.payload.url ?? '');
  const shots = (s.payload.shots as string[] | undefined) ?? [];
  return /^https?:\/\/\S+$/i.test(url) && shots.length >= 1;
};

async function sign(paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const { data } = await supabase.storage.from('zillow-screenshots').createSignedUrls(paths, 60 * 60 * 3);
  const by = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
  return paths.map((p) => by.get(p) ?? '');
}

async function toFinalist(ctx: GameCtx, s: Submission, count: number): Promise<Finalist> {
  const ids = new Set(ctx.players.map((p) => p.id));
  return {
    id: s.id,
    authorId: s.player_id && ids.has(s.player_id) ? s.player_id : null,
    url: String(s.payload.url),
    shots: await sign((s.payload.shots as string[]) ?? []),
    count,
  };
}

const liveFinalists = (ctx: GameCtx) => {
  const dq = dqOf(ctx);
  return ((ctx.room.state.finalists as Finalist[] | undefined) ?? []).filter((f) => !dq.includes(f.id));
};

async function startGallery(ctx: GameCtx) {
  const info = infoOf(ctx);
  const dq = dqOf(ctx);
  const subs = ctx.roundSubs('listing').filter((s) => validListing(s) && !dq.includes(s.id));
  if (!subs.length) return ctx.setStep('empty', { info });
  const entries: Entry[] = [];
  for (const [i, s] of shuffle(subs).entries()) {
    entries.push({ id: s.id, label: i + 1, shots: await sign((s.payload.shots as string[]) ?? []) });
  }
  if (entries.length === 1) return startTop3(ctx, entries);
  await ctx.setStep(
    'gallery',
    { info, entries, dqIds: dq, ruled: [] },
    { seconds: GALLERY_SECONDS, vote: ['pick'], submit: challengeKinds(info), track: 'vote' },
  );
}

async function startTop3(ctx: GameCtx, entriesOverride?: Entry[]) {
  const info = infoOf(ctx);
  const dq = dqOf(ctx);
  const entries = entriesOverride ?? (ctx.room.state.entries as Entry[]);
  const votes = ctx.roundVotes('pick').filter((v) => v.target_submission_id && !dq.includes(v.target_submission_id));
  const count = (id: string) => votes.filter((v) => v.target_submission_id === id).length;
  const ranked = shuffle(entries.filter((e) => !dq.includes(e.id)))
    .map((e) => ({ e, n: count(e.id) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  const finalists: Finalist[] = [];
  for (const { e, n } of ranked) {
    const sub = ctx.roundSubs('listing').find((s) => s.id === e.id)!;
    finalists.push(await toFinalist(ctx, sub, n));
  }
  await ctx.award(
    finalists.filter((f) => f.authorId && f.count).map((f) => ({ playerId: f.authorId!, points: f.count * GALLERY_VOTE_POINTS, reason: REASON.zilVotes })),
  );
  // Gallery votes for everyone else also score, not just the top 3.
  const extra = entries
    .filter((e) => !finalists.some((f) => f.id === e.id) && !dq.includes(e.id))
    .map((e) => ({ sub: ctx.roundSubs('listing').find((s) => s.id === e.id), n: count(e.id) }))
    .filter((x) => x.sub?.player_id && x.n)
    .map((x) => ({ playerId: x.sub!.player_id!, points: x.n * GALLERY_VOTE_POINTS, reason: REASON.zilVotes }));
  await ctx.award(extra);
  await ctx.setStep('top3', { info, finalists, dqIds: dq, ruled: ctx.room.state.ruled ?? [] }, { submit: challengeKinds(info), track: 'vote' });
}

async function startPitch(ctx: GameCtx, idx: number) {
  const info = infoOf(ctx);
  const finalists = liveFinalists(ctx);
  if (idx >= finalists.length) return startFinal(ctx);
  await ctx.setStep(
    'pitch',
    { info, finalists: ctx.room.state.finalists, idx, dqIds: dqOf(ctx), ruled: ctx.room.state.ruled ?? [] },
    { seconds: PITCH_SECONDS, submit: challengeKinds(info), track: 'vote' },
  );
}

async function startFinal(ctx: GameCtx) {
  const info = infoOf(ctx);
  const finalists = liveFinalists(ctx);
  if (finalists.length < 2) return reveal(ctx);
  await ctx.setStep('final', { info, finalists, dqIds: dqOf(ctx) }, { seconds: FINAL_SECONDS, vote: ['final'] });
}

async function reveal(ctx: GameCtx) {
  const info = infoOf(ctx);
  const finalists = liveFinalists(ctx);
  const votes = ctx.roundVotes('final');
  const results: Result[] = finalists
    .map((f) => ({ ...f, count: votes.filter((v) => v.target_submission_id === f.id).length, points: 0 }))
    .sort((a, b) => b.count - a.count);
  for (const r of results) {
    const rank = results.findIndex((x) => x.count === r.count); // ties share the better placement
    r.points = FINAL_POINTS[rank] ?? 0;
  }
  await ctx.award(results.filter((r) => r.authorId).map((r) => ({ playerId: r.authorId!, points: r.points, reason: REASON.zilFinal })));
  await ctx.setStep('reveal', { info, results });
}

export const zillowHunt: GameModule = {
  id: 'zillow_hunt',
  title: 'Zillow Hunt',
  emoji: '🏠',
  tagline: 'Find the dream home. Sell it to the room.',
  rules: [
    'The TV announces a location and a challenge. Search Zillow on your own phone.',
    'Submit a listing link plus 1-3 screenshots before time runs out.',
    'Everyone votes in an anonymous gallery. The top 3 pitch live, then a final vote.',
    'On filter rounds, think someone cheated? Call it out. The host rules.',
  ],
  scored: true,
  defaultRounds: 3,
  maxRounds: 10,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & PromptRow>('zillow_prompts');
    await ctx.saveRun({ deck: rows.length ? leastUsed(rows) : FALLBACK, cursor: 0, dq: [] });
  },

  async startRound(ctx) {
    const st = ctx.run.state as { deck?: PromptRow[]; cursor?: number };
    const d = draw(st.deck?.length ? st.deck : FALLBACK, st.cursor ?? 0);
    markUsed('zillow_prompts', [d.item.id]);
    await ctx.saveRun({ deck: d.deck, cursor: d.cursor, dq: [], cur: d.item.id ? { table: 'zillow_prompts', id: d.item.id } : null });
    await ctx.setStep('announce', { info: buildInfo(d.item) }, { seconds: 10 });
  },

  /** Drop malformed listings (bad link or no screenshots) so they never reach the gallery. */
  async process(ctx) {
    const step = ctx.room.state.step;
    if (step !== 'search' && step !== 'submit') return;
    const bad = ctx.roundSubs('listing').filter((s) => !validListing(s));
    if (bad.length) await ctx.removeSubs(bad.map((s) => s.id));
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    const info = infoOf(ctx);
    if (step === 'announce') {
      return ctx.setStep('search', { info }, { seconds: SEARCH_SECONDS, submit: ['listing'] });
    }
    if (step === 'search') {
      const sent = new Set(ctx.roundSubs('listing').map((s) => s.player_id));
      if (ctx.players.filter((p) => p.connected).every((p) => sent.has(p.id))) return startGallery(ctx);
      return ctx.setStep('submit', { info }, { seconds: SUBMIT_SECONDS, submit: ['listing'] });
    }
    if (step === 'submit') return startGallery(ctx);
    if (step === 'gallery') return startTop3(ctx);
    if (step === 'top3') return startPitch(ctx, 0);
    if (step === 'pitch') return startPitch(ctx, Number(ctx.room.state.idx) + 1);
    if (step === 'final') return reveal(ctx);
    return ctx.endRound(); // reveal, empty
  },

  ready(ctx) {
    const step = ctx.room.state.step;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (step === 'search' || step === 'submit') {
      const sent = new Set(ctx.roundSubs('listing').map((s) => s.player_id));
      return active.every((p) => sent.has(p.id));
    }
    if (step === 'gallery' || step === 'final') {
      const kind = step === 'gallery' ? 'pick' : 'final';
      const voted = new Set(ctx.roundVotes(kind).map((v) => v.voter_id));
      return active.every((p) => voted.has(p.id));
    }
    return false;
  },

  /** Host rulings on "Call it out". */
  async action(ctx, name, payload) {
    if (name !== 'rule') return;
    const challengeId = String(payload.challengeId);
    const target = String(payload.target);
    const ruled = [...((ctx.room.state.ruled as string[] | undefined) ?? []), challengeId];
    const dq = [...dqOf(ctx)];
    if (payload.uphold && target && !dq.includes(target)) dq.push(target);
    await ctx.saveRun({ dq });
    await ctx.patchState({ ruled, dqIds: dq });
  },

  TV: ZillowTV,
  Phone: ZillowPhone,
};

// ---------------------------------------------------------------- TV
function InfoBlock({ info, small = false }: { info: Info; small?: boolean }) {
  const kicker = { wildcard: 'Wildcard', filter: 'Filter round', weird: 'Weird constraint' }[info.type];
  return (
    <div className={`zil-info${small ? ' zil-info-small' : ''}`}>
      <div className="zil-kicker">{kicker}</div>
      <h1 className="display zil-headline">{info.headline}</h1>
      <div className="zil-where">📍 {info.location}</div>
      {info.filters.length > 0 && (
        <ul className="zil-filters">
          {info.filters.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Shots({ shots, big = false }: { shots: string[]; big?: boolean }) {
  return (
    <div className={`zil-shots${big ? ' zil-shots-big' : ''}`}>
      {shots.map((s, i) => (s ? <img key={i} src={s} alt="" /> : null))}
    </div>
  );
}

function ZillowTV({ room, players, subs, engine }: TVGameProps) {
  const step = room.state.step;
  const info = room.state.info as Info;
  const map = new Map(players.map((p) => [p.id, p]));
  const done = (room.state.done ?? []).length;
  const dqIds = (room.state.dqIds as string[] | undefined) ?? [];
  const ruled = (room.state.ruled as string[] | undefined) ?? [];
  const entries = (room.state.entries as Entry[] | undefined) ?? [];
  const finalists = (room.state.finalists as Finalist[] | undefined) ?? [];

  const label = (id: string) => {
    const e = entries.find((x) => x.id === id);
    if (e) return `Listing #${e.label}`;
    const f = finalists.find((x) => x.id === id);
    const a = f?.authorId ? map.get(f.authorId) : null;
    return a ? `${a.name}'s listing` : 'a listing';
  };

  const open = subs.filter((s) => s.round === room.round && s.kind === 'challenge' && !ruled.includes(s.id));
  const banner =
    open.length > 0 && (step === 'gallery' || step === 'top3' || step === 'pitch') ? (
      <div className="zil-challenges">
        {open.map((c) => {
          const by = c.player_id ? map.get(c.player_id) : null;
          const target = String(c.payload.target ?? '');
          return (
            <div key={c.id} className="zil-challenge pop-in">
              <span>🚩 {by && <PlayerChip player={by} size="sm" />} calls out <b>{label(target)}</b></span>
              <span className="row gap">
                <button className="btn btn-sm btn-danger" onClick={() => void engine.gameAction('rule', { challengeId: c.id, target, uphold: true })}>
                  Disqualify
                </button>
                <button className="btn btn-sm" onClick={() => void engine.gameAction('rule', { challengeId: c.id, target, uphold: false })}>
                  Dismiss
                </button>
              </span>
            </div>
          );
        })}
      </div>
    ) : null;

  if (step === 'announce') {
    return (
      <div className="center-stack">
        <p className="lead dim">Get your phones ready…</p>
        <InfoBlock info={info} />
      </div>
    );
  }

  if (step === 'search' || step === 'submit') {
    return (
      <div className="center-stack">
        <InfoBlock info={info} small />
        <p className="lead">
          {step === 'search' ? 'Search Zillow on your phone. Screenshot your best find, then submit it.' : 'Last call! Submit your listing now.'}
        </p>
        <p className="lead dim">{done} of {players.length} submitted</p>
      </div>
    );
  }

  if (step === 'empty') {
    return (
      <div className="center-stack">
        <InfoBlock info={info} small />
        <p className="lead">Nobody submitted a listing. Moving on.</p>
      </div>
    );
  }

  if (step === 'gallery') {
    return (
      <div className="zil-gallery-wrap">
        {banner}
        <div className="zil-gallery-head">
          <InfoBlock info={info} small />
          <p className="lead dim">Vote for the best listing ({done} of {players.length})</p>
        </div>
        <div className="zil-gallery">
          {entries.map((e) => (
            <div key={e.id} className={`zil-entry${dqIds.includes(e.id) ? ' zil-dq' : ''}`}>
              <div className="zil-entry-label">#{e.label}{dqIds.includes(e.id) && ' · DISQUALIFIED'}</div>
              <Shots shots={e.shots} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === 'top3') {
    return (
      <div className="center-stack">
        {banner}
        <h1 className="display">Top {finalists.length === 1 ? 'listing' : finalists.length}</h1>
        <div className="zil-top3">
          {finalists.map((f, i) => {
            const a = f.authorId ? map.get(f.authorId) : null;
            return (
              <div key={f.id} className={`zil-finalist pop-in${dqIds.includes(f.id) ? ' zil-dq' : ''}`} style={{ animationDelay: `${i * 150}ms` }}>
                <Shots shots={f.shots.slice(0, 1)} />
                {a && <PlayerChip player={a} size="lg" />}
                <span className="dim">{f.count} vote{f.count === 1 ? '' : 's'}</span>
              </div>
            );
          })}
        </div>
        <p className="tv-footer">Pitches next. <kbd>Space</kbd></p>
      </div>
    );
  }

  if (step === 'pitch') {
    const live = finalists.filter((f) => !dqIds.includes(f.id));
    const idx = Number(room.state.idx ?? 0);
    const f = live[idx];
    const a = f?.authorId ? map.get(f.authorId) : null;
    if (!f) return null;
    return (
      <div className="zil-pitch">
        {banner}
        <div className="row gap center wrap">
          <span className="lead">Pitch {idx + 1} of {live.length}</span>
          {a && <PlayerChip player={a} size="xl" />}
          <span className="lead">sell us this house!</span>
        </div>
        <Shots shots={f.shots} big />
        <p className="zil-url">{f.url}</p>
      </div>
    );
  }

  if (step === 'final') {
    return (
      <div className="center-stack">
        <h1 className="display">Final vote</h1>
        <p className="lead dim">Which pitch wins? ({done} of {players.length})</p>
        <div className="zil-top3">
          {finalists.map((f) => {
            const a = f.authorId ? map.get(f.authorId) : null;
            return (
              <div key={f.id} className="zil-finalist">
                <Shots shots={f.shots.slice(0, 1)} />
                {a && <PlayerChip player={a} size="lg" />}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const results = (room.state.results as Result[] | undefined) ?? [];
  const winner = results[0];
  const wa = winner?.authorId ? map.get(winner.authorId) : null;
  return (
    <div className="center-stack">
      <p className="lead dim">Dream home hunter</p>
      {wa && <div className="pop-in"><PlayerChip player={wa} size="xl" /></div>}
      {winner && <Shots shots={winner.shots.slice(0, 2)} />}
      <ol className="standings">
        {results.map((r) => {
          const a = r.authorId ? map.get(r.authorId) : null;
          return (
            <li key={r.id}>
              {a && <PlayerChip player={a} size="lg" />}
              <span className="dim">{r.count} vote{r.count === 1 ? '' : 's'}</span>
              <span className="points">+{r.points}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- phone
function PromptCard({ info }: { info: Info }) {
  return (
    <div className="card stack">
      <div className="zil-kicker">{{ wildcard: 'Wildcard', filter: 'Filter round', weird: 'Weird constraint' }[info.type]}</div>
      <h2>{info.headline}</h2>
      <div>📍 {info.location}</div>
      {info.filters.length > 0 && (
        <ul className="zil-filters">
          {info.filters.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ZillowPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const info = room.state.info as Info;
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mine = api.mySubs.find((s) => s.kind === 'listing');
  const myChallenge = api.mySubs.find((s) => s.kind === 'challenge')?.payload.target as string | undefined;
  const dqIds = (room.state.dqIds as string[] | undefined) ?? [];

  const callOut = (id: string) => {
    setErr(null);
    api.submit('challenge', { target: id }).catch((e) => setErr(errorCode(e)));
  };

  if (step === 'announce') {
    return (
      <div className="stack gap">
        <PromptCard info={info} />
        <p className="center dim">Get ready to search…</p>
      </div>
    );
  }

  if (step === 'search' || step === 'submit') return <ListingForm room={room} me={me} info={info} api={api} mine={mine} />;

  if (step === 'empty') return <div className="phone-center"><h2>Nobody submitted. Moving on.</h2></div>;

  if (step === 'gallery') {
    const entries = (room.state.entries as Entry[]) ?? [];
    const picked = pending ?? api.myVotes.find((v) => v.kind === 'pick')?.target_submission_id ?? null;
    return (
      <div className="stack gap">
        <p className="center dim">Vote for the best listing</p>
        {entries.map((e) => {
          const own = e.id === mine?.id;
          const gone = dqIds.includes(e.id);
          return (
            <div key={e.id} className={`card stack${picked === e.id ? ' selected-card' : ''}${gone ? ' zil-dq' : ''}`}>
              <strong>Listing #{e.label}{own && ' (yours)'}{gone && ' · disqualified'}</strong>
              <Shots shots={e.shots} />
              <div className="row gap">
                <button
                  className="btn btn-primary grow"
                  disabled={own || gone}
                  onClick={() => {
                    setErr(null);
                    setPending(e.id);
                    api.vote('pick', { submissionId: e.id }).catch((x) => setErr(errorCode(x))).finally(() => setPending(null));
                  }}
                >
                  {picked === e.id ? '✓ Your vote' : 'Vote'}
                </button>
                {info.type === 'filter' && !own && (
                  <button className={`btn${myChallenge === e.id ? ' btn-danger' : ''}`} disabled={gone} onClick={() => callOut(e.id)}>
                    🚩 {myChallenge === e.id ? 'Called out' : 'Call it out'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  const finalists = (room.state.finalists as Finalist[]) ?? [];
  const byAuthor = (f: Finalist): Player | undefined => players.find((p) => p.id === f.authorId);

  if (step === 'top3') {
    return (
      <div className="phone-center center-stack">
        <h2>Top listings</h2>
        {finalists.map((f) => byAuthor(f) && <PlayerChip key={f.id} player={byAuthor(f)!} size="lg" />)}
        <p className="dim">Pitches are next. Look at the TV.</p>
      </div>
    );
  }

  if (step === 'pitch') {
    const live = finalists.filter((f) => !dqIds.includes(f.id));
    const f = live[Number(room.state.idx ?? 0)];
    const a = f ? byAuthor(f) : undefined;
    const you = a?.id === me.id;
    return (
      <div className="phone-center center-stack">
        {you ? <h2>🎤 You are pitching! 45 seconds, sell it!</h2> : <h2>Listen to the pitch</h2>}
        {a && <PlayerChip player={a} size="xl" />}
        {info.type === 'filter' && f && !you && (
          <button className={`btn${myChallenge === f.id ? ' btn-danger' : ''}`} onClick={() => callOut(f.id)}>
            🚩 {myChallenge === f.id ? 'Called out' : 'Call it out'}
          </button>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    );
  }

  if (step === 'final') {
    const picked = pending ?? api.myVotes.find((v) => v.kind === 'final')?.target_submission_id ?? null;
    return (
      <div className="stack gap">
        <p className="center dim">Final vote: whose pitch wins?</p>
        {finalists.map((f) => {
          const a = byAuthor(f);
          const own = a?.id === me.id;
          return (
            <button
              key={f.id}
              className={`vote-option${picked === f.id ? ' selected' : ''}`}
              disabled={own}
              onClick={() => {
                setErr(null);
                setPending(f.id);
                api.vote('final', { submissionId: f.id }).catch((x) => setErr(errorCode(x))).finally(() => setPending(null));
              }}
            >
              {a && <PlayerChip player={a} size="lg" />}
            </button>
          );
        })}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  const results = (room.state.results as Result[]) ?? [];
  const my = results.find((r) => r.authorId === me.id);
  const champ = results[0];
  const champP = champ ? byAuthor(champ) : undefined;
  return (
    <div className="phone-center center-stack">
      <p className="dim">Dream home hunter</p>
      {champP && <PlayerChip player={champP} size="xl" />}
      {my && <p className="points big-num">+{my.points}</p>}
    </div>
  );
}

function ListingForm({
  room, me, info, api, mine,
}: {
  room: PhoneGameProps['room']; me: Player; info: Info; api: PhoneGameProps['api']; mine?: Submission;
}) {
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlOk = /^https?:\/\/\S+$/i.test(url.trim());

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const paths: string[] = [];
      for (const file of files) {
        const blob = await downscale(file, 1400, 0.8);
        const path = `${me.user_id}/${room.current_run_id}/${room.round}/${randomId()}.jpg`;
        const up = await supabase.storage.from('zillow-screenshots').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw up.error;
        paths.push(path);
      }
      await api.submit('listing', { url: url.trim(), shots: paths });
      setFiles([]);
      setUrl('');
    } catch (e) {
      setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late, submissions are closed.' : errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap">
      <PromptCard info={info} />
      <a className="btn btn-lg" href="https://www.zillow.com/" target="_blank" rel="noreferrer">
        Open Zillow ↗
      </a>
      {mine && (
        <div className="card center-stack">
          <h3>✅ Submitted</h3>
          <p className="dim">You can resubmit below to replace it until time is up.</p>
        </div>
      )}
      <div className="card stack gap">
        <strong>{mine ? 'Replace your listing' : 'Submit your listing'}</strong>
        <input
          className="input"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="Paste the listing link (https://…)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 3))}
        />
        <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
          📸 {files.length ? `${files.length} screenshot${files.length === 1 ? '' : 's'} chosen` : 'Add 1-3 screenshots'}
        </button>
        <button className="btn btn-primary btn-lg" disabled={busy || !urlOk || files.length === 0} onClick={() => void send()}>
          {busy ? 'Uploading…' : mine ? 'Replace' : 'Submit'}
        </button>
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}
