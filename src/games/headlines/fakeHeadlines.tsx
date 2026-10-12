import { useEffect, useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { shuffle } from '../../lib/random';
import { errorCode, supabase } from '../../lib/supabase';
import type { Player } from '../../lib/types';
import { REASON } from '../reasons';
import { AnonOptions, VoteList } from '../shared/anon';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';
import { HEADLINES_CONFIG as C } from './config';

/**
 * Fake Headlines. A photo is on the TV; everyone writes a fake news headline. Two anonymous votes
 * on the same list: Funniest, then Most Believable. Authors are unmasked with a winner for each.
 *
 * Photos come from the `headline` pool of caption_images (plus, optionally, the friends pool).
 * An image is never shown twice in a night: shown image keys are remembered across every Fake
 * Headlines run in this room.
 */

interface ImageRef {
  id?: string;
  pool?: string;
  url?: string | null;
  storage_path?: string | null;
}
interface RunState {
  headline?: ImageRef[];
  friends?: ImageRef[];
  seen?: string[];
}
interface HeadItem {
  id: string;
  text: string;
  authorId: string | null;
  fun: number;
  bel: number;
}

const BUILTIN: ImageRef[] = Array.from({ length: C.builtinCount }, (_, i) => ({
  pool: 'headline',
  url: `/headlines/${String(i + 1).padStart(2, '0')}.svg`,
}));

const keyOf = (img: ImageRef) => img.id ?? img.url ?? img.storage_path ?? '';
const textOf = (p: Record<string, unknown>) => String(p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, C.maxHeadlineLength + 20);

async function resolveUrl(img: ImageRef): Promise<string> {
  if (img.url) return img.url;
  const { data } = await supabase.storage.from('caption-images').createSignedUrl(img.storage_path!, 60 * 60 * 3);
  return data?.signedUrl ?? '';
}

async function startVote(ctx: GameCtx, which: 'fun' | 'bel') {
  const prev = ctx.room.state.options as { id: string; text: string }[] | undefined;
  let options = prev;
  if (!options) {
    const subs = ctx.roundSubs('headline').filter((s) => textOf(s.payload));
    if (!subs.length) return ctx.endRound();
    options = shuffle(subs.map((s) => ({ id: s.id, text: textOf(s.payload) })));
  }
  if (options.length < 2) return reveal(ctx);
  await ctx.setStep(
    'vote',
    { imageUrl: ctx.room.state.imageUrl, options, which },
    { seconds: C.voteSeconds, vote: [which === 'fun' ? 'hl_fun' : 'hl_bel'] },
  );
}

async function reveal(ctx: GameCtx) {
  const ids = new Set(ctx.players.map((p) => p.id));
  const fun = ctx.roundVotes('hl_fun');
  const bel = ctx.roundVotes('hl_bel');
  const items: HeadItem[] = ctx
    .roundSubs('headline')
    .map((s) => ({
      id: s.id,
      text: textOf(s.payload),
      authorId: s.player_id && ids.has(s.player_id) ? s.player_id : null,
      fun: fun.filter((v) => v.target_submission_id === s.id).length,
      bel: bel.filter((v) => v.target_submission_id === s.id).length,
    }))
    .filter((i) => i.text)
    .sort((a, b) => b.fun + b.bel - (a.fun + a.bel));

  const top = (k: 'fun' | 'bel') => {
    const m = Math.max(0, ...items.map((i) => i[k]));
    return m > 0 ? items.filter((i) => i[k] === m).map((i) => i.id) : [];
  };
  const funWinners = top('fun');
  const belWinners = C.believableVote ? top('bel') : [];

  await ctx.award(
    items.flatMap((it) =>
      it.authorId
        ? [
            { playerId: it.authorId, points: it.fun * C.funnyPerVote, reason: REASON.hlFunny },
            { playerId: it.authorId, points: funWinners.includes(it.id) ? C.funnyWinBonus : 0, reason: REASON.hlFunnyWin },
            { playerId: it.authorId, points: it.bel * C.believablePerVote, reason: REASON.hlBelieve },
            { playerId: it.authorId, points: belWinners.includes(it.id) ? C.believableWinBonus : 0, reason: REASON.hlBelieveWin },
          ]
        : [],
    ),
  );
  await ctx.setStep('reveal', { imageUrl: ctx.room.state.imageUrl, items, funWinners, belWinners });
}

/** Choose and show a fresh photo (never one already used tonight) and open the headline writing. */
async function beginRound(ctx: GameCtx) {
  const st = ctx.run.state as RunState;
  const seen = new Set(st.seen ?? []);
  const fresh = (list?: ImageRef[]) => (list ?? []).filter((i) => !seen.has(keyOf(i)));
  const mix = Number(ctx.room.settings.headlineFriendMix ?? 0);

  let pool = Math.random() < mix ? fresh(st.friends) : [];
  if (!pool.length) pool = fresh(st.headline);
  if (!pool.length) pool = fresh(st.friends);
  let recycled = false;
  if (!pool.length) {
    // Every photo has been used tonight; start over rather than stall the game.
    recycled = true;
    pool = [...(st.headline ?? []), ...(st.friends ?? [])];
  }
  const image = shuffle(pool)[0] ?? BUILTIN[0];
  markUsed('caption_images', [image.id]);
  await ctx.saveRun({ seen: recycled ? [keyOf(image)] : [...seen, keyOf(image)], cur: image.id ? { table: 'caption_images', id: image.id } : null });
  const imageUrl = await resolveUrl(image);
  await ctx.setStep('write', { imageUrl }, { seconds: C.writeSeconds, submit: ['headline'] });
}

export const fakeHeadlines: GameModule = {
  id: 'fake_headlines',
  title: 'Fake Headlines',
  emoji: '📰',
  tagline: 'One photo. Write the headline nobody would print.',
  rules: [
    'A photo appears on the TV. Write a fake news headline for it.',
    'First vote: the FUNNIEST headline.',
    C.believableVote ? 'Second vote: the MOST BELIEVABLE headline.' : 'Votes and a winner bonus score.',
    'You can\'t vote for your own. Each winner gets a bonus.',
  ],
  scored: true,
  defaultRounds: C.defaultRounds,
  maxRounds: C.maxRounds,
  status: 'ready',

  async setup(ctx) {
    const rows = await loadBank<BankRow & ImageRef>('caption_images');
    const headline = leastUsed(rows.filter((r) => r.pool === 'headline'));
    const friends = leastUsed(rows.filter((r) => r.pool === 'friends'));

    // Remember every photo already shown in this room, across all Fake Headlines runs tonight.
    const { data } = await supabase.from('game_runs').select('state').eq('room_id', ctx.room.id).eq('game_type', 'fake_headlines');
    const seen = new Set<string>();
    for (const r of data ?? []) for (const k of ((r.state as RunState).seen ?? [])) seen.add(k);

    await ctx.saveRun({ headline: headline.length ? headline : BUILTIN, friends, seen: [...seen] });
  },

  startRound: beginRound,

  async next(ctx) {
    const state = ctx.room.state;
    if (state.step === 'write') return startVote(ctx, 'fun');
    if (state.step === 'vote') {
      if (state.which === 'fun' && C.believableVote) return startVote(ctx, 'bel');
      return reveal(ctx);
    }
    return ctx.endRound();
  },

  ready(ctx) {
    const state = ctx.room.state;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (state.step === 'write') {
      const sent = new Set(ctx.roundSubs('headline').map((s) => s.player_id));
      return active.every((p) => sent.has(p.id));
    }
    if (state.step === 'vote') {
      const kind = state.which === 'fun' ? 'hl_fun' : 'hl_bel';
      const voted = new Set(ctx.roundVotes(kind).map((v) => v.voter_id));
      return active.every((p) => voted.has(p.id));
    }
    return false;
  },

  TV: HeadlinesTV,
  Phone: HeadlinesPhone,
};

// ---------------------------------------------------------------- TV
function NewsPhoto({ url, chyron }: { url: string; chyron?: string }) {
  return (
    <div className="news-photo">
      {url ? <img src={url} alt="" /> : <div className="spinner" />}
      {chyron !== undefined && (
        <div className="news-chyron">
          <span className="news-tag">BREAKING</span>
          <span className="news-chyron-text">{chyron}</span>
        </div>
      )}
    </div>
  );
}

function HeadlinesTV({ room, players }: TVGameProps) {
  const step = room.state.step;
  const imageUrl = String(room.state.imageUrl ?? '');
  const map = new Map(players.map((p) => [p.id, p]));
  const done = (room.state.done ?? []).length;

  if (step === 'write') {
    return (
      <div className="center-stack news-stage">
        <NewsPhoto url={imageUrl} chyron="Write the headline on your phone…" />
        <p className="lead dim">{done} of {players.length} filed a story</p>
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    const fun = room.state.which === 'fun';
    return (
      <div className="news-split">
        <NewsPhoto url={imageUrl} />
        <div className="news-list">
          <div className="news-ask">{fun ? '😂 Which is FUNNIEST?' : '🧐 Which is MOST BELIEVABLE?'}</div>
          <p className="lead dim">{done} of {players.length} voted</p>
          <AnonOptions options={options} render={(o) => <span className="news-headline">{o.text}</span>} />
        </div>
      </div>
    );
  }

  const items = (room.state.items as HeadItem[]) ?? [];
  const funWinners = (room.state.funWinners as string[]) ?? [];
  const belWinners = (room.state.belWinners as string[]) ?? [];
  const pts = (it: HeadItem) =>
    it.fun * C.funnyPerVote + (funWinners.includes(it.id) ? C.funnyWinBonus : 0) + it.bel * C.believablePerVote + (belWinners.includes(it.id) ? C.believableWinBonus : 0);
  return (
    <div className="news-split">
      <NewsPhoto url={imageUrl} />
      <div className="news-list">
        {items.length === 0 && <p className="lead">No headlines were filed.</p>}
        {items.map((it, i) => {
          const author = it.authorId ? map.get(it.authorId) : null;
          return (
            <div key={it.id} className="anon-card news-card pop-in" style={{ animationDelay: `${i * 90}ms` }}>
              <div className="news-badges">
                {funWinners.includes(it.id) && <span className="news-badge">🏆 FUNNIEST</span>}
                {belWinners.includes(it.id) && <span className="news-badge news-badge-bel">🏆 MOST BELIEVABLE</span>}
              </div>
              <div className="news-headline">{it.text}</div>
              <div className="anon-meta">
                {author ? <PlayerChip player={author} size="sm" /> : <span className="dim">someone who left</span>}
                <span className="dim">😂 {it.fun}{C.believableVote ? ` · 🧐 ${it.bel}` : ''}</span>
                {pts(it) > 0 && <span className="points">+{pts(it)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- phone
function HeadlinesPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const imageUrl = String(room.state.imageUrl ?? '');
  const mine = api.mySubs.find((s) => s.kind === 'headline');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(''), [imageUrl]);

  if (step === 'write') {
    const send = async () => {
      setBusy(true);
      setErr(null);
      try {
        await api.submit('headline', { text: text.trim() });
      } catch (e) {
        setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Time is up!' : errorCode(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="stack gap">
        <img className="cap-thumb" src={imageUrl} alt="" />
        <textarea
          className="input input-lg"
          rows={3}
          value={text}
          maxLength={C.maxHeadlineLength}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your fake headline…"
        />
        <div className="row gap">
          <span className="dim small grow">{text.length}/{C.maxHeadlineLength}</span>
          <button className="btn btn-primary btn-lg" disabled={busy || !text.trim()} onClick={() => void send()}>
            {mine ? 'Update' : 'File it'}
          </button>
        </div>
        {mine && <p className="center dim">Filed: “{String(mine.payload.text)}”. Edit until time is up.</p>}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    const fun = room.state.which === 'fun';
    return (
      <div className="stack gap">
        <img className="cap-thumb" src={imageUrl} alt="" />
        <h3 className="center">{fun ? '😂 Which is FUNNIEST?' : '🧐 Which is MOST BELIEVABLE?'}</h3>
        <VoteList key={String(room.state.which)} options={options} mineId={mine?.id} kind={fun ? 'hl_fun' : 'hl_bel'} api={api} />
      </div>
    );
  }

  const items = (room.state.items as HeadItem[]) ?? [];
  const funWinners = (room.state.funWinners as string[]) ?? [];
  const belWinners = (room.state.belWinners as string[]) ?? [];
  const myItem = items.find((i) => i.authorId === me.id);
  const pts = myItem
    ? myItem.fun * C.funnyPerVote + (funWinners.includes(myItem.id) ? C.funnyWinBonus : 0) + myItem.bel * C.believablePerVote + (belWinners.includes(myItem.id) ? C.believableWinBonus : 0)
    : 0;
  const nameOf = (id?: string): Player | undefined => players.find((p) => p.id === items.find((i) => i.id === id)?.authorId);
  return (
    <div className="phone-center center-stack">
      <p className="dim">😂 Funniest</p>
      <h3>{items.find((i) => funWinners.includes(i.id))?.text ?? '—'}</h3>
      {nameOf(funWinners[0]) && <PlayerChip player={nameOf(funWinners[0])!} size="md" />}
      {C.believableVote && (
        <>
          <p className="dim">🧐 Most believable</p>
          <h3>{items.find((i) => belWinners.includes(i.id))?.text ?? '—'}</h3>
          {nameOf(belWinners[0]) && <PlayerChip player={nameOf(belWinners[0])!} size="md" />}
        </>
      )}
      {myItem ? <p className="points big-num">+{pts}</p> : <p className="dim">You did not file a headline.</p>}
    </div>
  );
}
