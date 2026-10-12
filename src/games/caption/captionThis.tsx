import { useMemo, useRef, useState } from 'react';
import { PlayerChip } from '../../components/PlayerChip';
import { downscale, randomId } from '../../lib/image';
import { draw, shuffle } from '../../lib/random';
import { leastUsed, loadBank, markUsed, type BankRow } from '../../lib/bank';
import { errorCode, supabase } from '../../lib/supabase';
import type { Player } from '../../lib/types';
import { CAP_VOTE_POINTS, CAP_WIN_BONUS, REASON } from '../reasons';
import type { GameCtx, GameModule, PhoneGameProps, TVGameProps } from '../types';

/**
 * Caption This. A photo is on the TV. Each phone holds a hand of 7 caption cards
 * (plus a write-your-own slot) and plays one. Captions are shown anonymously, everyone
 * votes (never for their own), then the winner and author are revealed.
 *
 * Hands are private: the TV writes each player's hand as a 'hand' submission that
 * RLS only lets that player read.
 */

const HAND_SIZE = 7;
const WRITE_SECONDS = 50;
const VOTE_SECONDS = 35;
const MAX_LEN = 80;
const PHOTO_SECONDS = 60;
/** Player photos reuse the existing private bucket (players may write only into their own folder). */
const PLAYER_BUCKET = 'zillow-screenshots';

interface ImageRef {
  id?: string;
  pool: 'generic' | 'friends' | 'player';
  bucket?: string;
  by?: string | null;
  url?: string | null;
  storage_path?: string | null;
  credit?: string | null;
}

interface Item {
  id: string;
  text: string;
  authorId: string | null;
  count: number;
}

const BUILTIN_IMAGES: ImageRef[] = Array.from({ length: 12 }, (_, i) => ({
  pool: 'generic' as const,
  url: `/captions/${String(i + 1).padStart(2, '0')}.svg`,
  credit: 'Generated placeholder',
}));

const BUILTIN_CARDS = [
  'When the group chat goes quiet',
  'Me, fully prepared, unprepared',
  'This is fine.',
  'Sir, this is a Wendy\'s.',
  'Bold of you to assume I have a plan.',
  'Pray for me',
  'Not my best work, but it\'s work',
  'Honestly, same.',
];

interface RunState {
  generic?: ImageRef[];
  friends?: ImageRef[];
  gi?: number;
  fi?: number;
  cards?: string[];
  cardIds?: Record<string, string>;
  ci?: number;
  hands?: Record<string, string[]>;
  photosDone?: boolean;
  playerPhotos?: { path: string; by: string }[];
  ppi?: number;
  currentBy?: string | null;
}

async function resolveUrl(img: ImageRef): Promise<string> {
  if (img.url) return img.url;
  const { data } = await supabase.storage.from(img.bucket ?? 'caption-images').createSignedUrl(img.storage_path!, 60 * 60 * 3);
  return data?.signedUrl ?? '';
}

async function deal(ctx: GameCtx) {
  const st = ctx.run.state as RunState;
  let cards = st.cards ?? BUILTIN_CARDS;
  let ci = st.ci ?? 0;
  const hands = { ...(st.hands ?? {}) };
  for (const p of ctx.players) {
    const hand = [...(hands[p.id] ?? [])];
    let guard = 0;
    while (hand.length < HAND_SIZE && guard++ < 500) {
      const d = draw(cards, ci);
      cards = d.deck;
      ci = d.cursor;
      if (!hand.includes(d.item) || cards.length <= hand.length) hand.push(d.item);
    }
    hands[p.id] = hand;
  }
  await ctx.saveRun({ cards, ci, hands });
  await ctx.addSubs(ctx.players.map((p) => ({ kind: 'hand', player_id: p.id, payload: { cards: hands[p.id] } })));
}

/** Pick this round's photo (players' own photos first), deal hands, and open captioning. */
async function beginWrite(ctx: GameCtx) {
  const st = ctx.run.state as RunState;
  let image: ImageRef;
  const mine = st.playerPhotos?.[st.ppi ?? 0];
  if (mine) {
    image = { pool: 'player', bucket: PLAYER_BUCKET, storage_path: mine.path, by: mine.by };
    await ctx.saveRun({ ppi: (st.ppi ?? 0) + 1 });
  } else {
    const mix = Number(ctx.room.settings.captionFriendMix ?? 0.3);
    const useFriends = (st.friends?.length ?? 0) > 0 && Math.random() < mix;
    if (useFriends) {
      const d = draw(st.friends!, st.fi ?? 0);
      image = d.item;
      await ctx.saveRun({ friends: d.deck, fi: d.cursor });
    } else {
      const d = draw(st.generic?.length ? st.generic : BUILTIN_IMAGES, st.gi ?? 0);
      image = d.item;
      await ctx.saveRun({ generic: d.deck, gi: d.cursor });
    }
    markUsed('caption_images', [image.id]);
  }
  await ctx.saveRun({ cur: image.id ? { table: 'caption_images', id: image.id } : null, currentBy: image.by ?? null });
  const imageUrl = await resolveUrl(image);
  await deal(ctx); // rows are written before the step so phones find them on their first fetch
  await ctx.setStep('write', { imageUrl, maxLen: MAX_LEN }, { seconds: WRITE_SECONDS, submit: ['caption'] });
}

/** End the photo step: keep everything uploaded, in random order, and start round 1. */
async function collectPhotos(ctx: GameCtx) {
  const photos = shuffle(
    ctx
      .roundSubs('photo')
      .filter((s) => s.player_id && typeof s.payload.path === 'string')
      .map((s) => ({ path: String(s.payload.path), by: s.player_id! })),
  );
  await ctx.saveRun({ photosDone: true, playerPhotos: photos, ppi: 0 });
  return beginWrite(ctx);
}

async function startVote(ctx: GameCtx) {
  const caps = ctx.roundSubs('caption').filter((s) => String(s.payload.text ?? '').trim());
  if (!caps.length) return ctx.endRound();
  const options = shuffle(caps.map((s) => ({ id: s.id, text: String(s.payload.text).trim() })));
  const imageUrl = String(ctx.room.state.imageUrl ?? '');
  if (caps.length < 2) return reveal(ctx);
  await ctx.setStep('vote', { imageUrl, options }, { seconds: VOTE_SECONDS, vote: ['cap'] });
}

async function reveal(ctx: GameCtx) {
  const ids = new Set(ctx.players.map((p) => p.id));
  const votes = ctx.roundVotes('cap');
  const items: Item[] = ctx
    .roundSubs('caption')
    .filter((s) => String(s.payload.text ?? '').trim())
    .map((s) => ({
      id: s.id,
      text: String(s.payload.text).trim(),
      authorId: s.player_id && ids.has(s.player_id) ? s.player_id : null,
      count: votes.filter((v) => v.target_submission_id === s.id).length,
    }))
    .sort((a, b) => b.count - a.count);
  const top = items[0]?.count ?? 0;
  const winners = items.filter((i) => i.count === top && top > 0).map((i) => i.id);

  const events: { playerId: string; points: number; reason: string }[] = [];
  for (const it of items) {
    if (!it.authorId) continue;
    if (it.count) events.push({ playerId: it.authorId, points: it.count * CAP_VOTE_POINTS, reason: REASON.capVotes });
    if (winners.includes(it.id)) events.push({ playerId: it.authorId, points: CAP_WIN_BONUS, reason: REASON.capWin });
  }
  await ctx.award(events);

  // Cards that were played leave the hand; they get replaced next round.
  const st = ctx.run.state as RunState;
  const hands = { ...(st.hands ?? {}) };
  for (const s of ctx.roundSubs('caption')) {
    if (s.payload.source === 'card' && s.player_id && hands[s.player_id]) {
      const i = hands[s.player_id].indexOf(String(s.payload.text));
      if (i >= 0) hands[s.player_id] = hands[s.player_id].filter((_, j) => j !== i);
    }
  }
  await ctx.saveRun({ hands });
  const cardIds = st.cardIds ?? {};
  markUsed(
    'caption_cards',
    ctx.roundSubs('caption').filter((s) => s.payload.source === 'card').map((s) => cardIds[String(s.payload.text)]),
  );
  await ctx.setStep('reveal', { imageUrl: ctx.room.state.imageUrl, items, winners, photoBy: st.currentBy ?? null });
}

export const captionThis: GameModule = {
  id: 'caption_this',
  title: 'Caption This',
  emoji: '🖼️',
  tagline: 'One photo. Many bad ideas.',
  rules: [
    'A photo appears on the TV.',
    'Add a funny photo from your phone and it may show up for everyone to caption.',
    'Pick a caption card from your hand, or write your own.',
    'Vote for the funniest caption (not your own). Winner takes the bonus.',
  ],
  scored: true,
  defaultRounds: 6,
  maxRounds: 30,
  status: 'ready',

  async setup(ctx) {
    const [imgs, cards] = await Promise.all([
      loadBank<BankRow & ImageRef>('caption_images'),
      loadBank<BankRow & { text: string }>('caption_cards'),
    ]);
    const generic = leastUsed(imgs.filter((i) => i.pool === 'generic'));
    const friends = leastUsed(imgs.filter((i) => i.pool === 'friends'));
    const ordered = leastUsed(cards).filter((c) => String(c.text).trim());
    const cardIds: Record<string, string> = {};
    for (const c of ordered) cardIds[String(c.text)] = c.id;
    await ctx.saveRun({
      generic: generic.length ? generic : BUILTIN_IMAGES,
      friends,
      gi: 0,
      fi: 0,
      cards: ordered.length >= HAND_SIZE ? ordered.map((c) => String(c.text)) : shuffle(BUILTIN_CARDS),
      cardIds,
      ci: 0,
      hands: {},
    });
  },

  async startRound(ctx) {
    const st = ctx.run.state as RunState;
    // Round 1 opens with an optional photo step, unless the host turned it off.
    if (ctx.room.round === 1 && !st.photosDone && ctx.room.settings.captionPlayerPhotos !== false) {
      return ctx.setStep('photos', {}, { seconds: PHOTO_SECONDS, submit: ['photo'] });
    }
    return beginWrite(ctx);
  },

  async next(ctx) {
    const step = ctx.room.state.step;
    if (step === 'photos') return collectPhotos(ctx);
    if (step === 'write') return startVote(ctx);
    if (step === 'vote') return reveal(ctx);
    return ctx.endRound();
  },

  ready(ctx) {
    const step = ctx.room.state.step;
    const active = ctx.players.filter((p) => p.connected);
    if (!active.length) return false;
    if (step === 'photos') {
      const sent = new Set(ctx.roundSubs('photo').map((s) => s.player_id));
      return active.every((p) => sent.has(p.id));
    }
    if (step === 'write') {
      const sent = new Set(ctx.roundSubs('caption').map((s) => s.player_id));
      return active.every((p) => sent.has(p.id));
    }
    if (step === 'vote') {
      const voted = new Set(ctx.roundVotes('cap').map((v) => v.voter_id));
      return active.every((p) => voted.has(p.id));
    }
    return false;
  },

  /** Skip: during the photo step, move on; otherwise deal the next photo (uploaded photos are kept). */
  async skip(ctx) {
    if (ctx.room.state.step === 'photos') return collectPhotos(ctx);
    await ctx.removeSubs(ctx.roundSubs().filter((s) => s.kind !== 'photo').map((s) => s.id));
    return beginWrite(ctx);
  },

  TV: CaptionTV,
  Phone: CaptionPhone,
};

function Photo({ url }: { url: string }) {
  return <div className="cap-photo">{url ? <img src={url} alt="" /> : <div className="spinner" />}</div>;
}

function CaptionTV({ room, players }: TVGameProps) {
  const imageUrl = String(room.state.imageUrl ?? '');
  const step = room.state.step;
  const map = new Map(players.map((p) => [p.id, p]));
  const done = (room.state.done ?? []).length;

  if (step === 'photos') {
    return (
      <div className="center-stack">
        <h1 className="display">📸 Add a photo!</h1>
        <p className="lead">Take or pick a funny photo on your phone. It might end up on the big screen for everyone to caption.</p>
        <p className="lead dim">{done} of {players.length} added one (optional)</p>
        <p className="tv-footer"><kbd>Space</kbd> to start</p>
      </div>
    );
  }

  if (step === 'write') {
    return (
      <div className="center-stack cap-stage">
        <Photo url={imageUrl} />
        <p className="lead">Pick a caption on your phone. {done} of {players.length} ready</p>
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    return (
      <div className="cap-split">
        <Photo url={imageUrl} />
        <div className="cap-list">
          <p className="lead dim">Vote for the funniest ({done} of {players.length})</p>
          {options.map((o, i) => (
            <div key={o.id} className="cap-card pop-in" style={{ animationDelay: `${i * 80}ms` }}>
              {o.text}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const items = (room.state.items as Item[]) ?? [];
  const winners = (room.state.winners as string[]) ?? [];
  const photoBy = room.state.photoBy ? map.get(String(room.state.photoBy)) : undefined;
  const winItems = items.filter((i) => winners.includes(i.id));
  const rest = items.filter((i) => !winners.includes(i.id));
  return (
    <div className="cap-split">
      <Photo url={imageUrl} />
      <div className="cap-list">
        {photoBy && <p className="lead">📸 Photo by <PlayerChip player={photoBy} size="md" /></p>}
        {winItems.length === 0 && <p className="lead">Nobody voted. Tough crowd.</p>}
        {winItems.map((it) => {
          const author = it.authorId ? map.get(it.authorId) : null;
          return (
            <div key={it.id} className="cap-card cap-winner pop-in">
              <div className="cap-winner-label">🏆 {winItems.length > 1 ? 'Tie! ' : ''}Funniest caption</div>
              <div>{it.text}</div>
              <div className="cap-meta">
                {author && <PlayerChip player={author} size="md" />}
                <span className="points">{it.count} vote{it.count === 1 ? '' : 's'} · +{it.count * CAP_VOTE_POINTS + CAP_WIN_BONUS}</span>
              </div>
            </div>
          );
        })}
        {rest.map((it, i) => {
          const author = it.authorId ? map.get(it.authorId) : null;
          return (
            <div key={it.id} className="cap-card pop-in" style={{ animationDelay: `${0.3 + i * 0.1}s` }}>
              <div>{it.text}</div>
              <div className="cap-meta">
                {author && <PlayerChip player={author} size="sm" />}
                <span className="dim">{it.count} vote{it.count === 1 ? '' : 's'}{it.count ? ` · +${it.count * CAP_VOTE_POINTS}` : ''}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CaptionPhone({ room, me, players, api }: PhoneGameProps) {
  const step = room.state.step;
  const imageUrl = String(room.state.imageUrl ?? '');
  const [own, setOwn] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mine = api.mySubs.find((s) => s.kind === 'caption');

  if (step === 'photos') return <PhotoUpload room={room} me={me} api={api} />;

  if (step === 'write') {
    const hand = ((api.mySubs.find((s) => s.kind === 'hand')?.payload.cards as string[] | undefined) ?? []);
    const send = async (text: string, source: 'card' | 'own') => {
      setBusy(text);
      setErr(null);
      try {
        await api.submit('caption', { text, source });
      } catch (e) {
        setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late!' : errorCode(e));
      } finally {
        setBusy(null);
      }
    };
    return (
      <div className="stack gap">
        <img className="cap-thumb" src={imageUrl} alt="" />
        {mine && (
          <div className="card center-stack">
            <p className="dim">Your caption (tap another to switch)</p>
            <h3>{String(mine.payload.text)}</h3>
          </div>
        )}
        <div className="stack gap">
          {hand.map((c) => (
            <button
              key={c}
              className={`cap-hand-card${mine?.payload.text === c ? ' selected' : ''}`}
              disabled={busy !== null}
              onClick={() => void send(c, 'card')}
            >
              {c}
            </button>
          ))}
        </div>
        <form
          className="card stack gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (own.trim()) void send(own.trim(), 'own');
          }}
        >
          <strong>Write your own</strong>
          <input className="input" value={own} maxLength={MAX_LEN} onChange={(e) => setOwn(e.target.value)} placeholder="Something funnier…" />
          <button className="btn btn-primary" disabled={busy !== null || !own.trim()}>Use this one</button>
        </form>
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  if (step === 'vote') {
    const options = (room.state.options as { id: string; text: string }[]) ?? [];
    const picked = pending ?? api.myVotes.find((v) => v.kind === 'cap')?.target_submission_id ?? null;
    return (
      <div className="stack gap">
        <img className="cap-thumb" src={imageUrl} alt="" />
        <p className="center dim">Vote for the funniest</p>
        {options.map((o) => {
          const isMine = o.id === mine?.id;
          return (
            <button
              key={o.id}
              className={`wf-pick${picked === o.id ? ' selected' : ''}`}
              disabled={isMine}
              onClick={() => {
                setErr(null);
                setPending(o.id);
                api
                  .vote('cap', { submissionId: o.id })
                  .catch((e) => setErr(errorCode(e) === 'OWN_SUBMISSION' ? "You can't vote for your own." : errorCode(e)))
                  .finally(() => setPending(null));
              }}
            >
              {o.text}
              {isMine && <span className="dim small"> (yours)</span>}
            </button>
          );
        })}
        {err && <p className="error center">{err}</p>}
      </div>
    );
  }

  const items = (room.state.items as Item[]) ?? [];
  const me2 = items.find((i) => i.authorId === me.id);
  const winners = (room.state.winners as string[]) ?? [];
  const won = me2 && winners.includes(me2.id);
  const champ = items.find((i) => winners.includes(i.id));
  const champAuthor: Player | undefined = champ?.authorId ? players.find((p) => p.id === champ.authorId) : undefined;
  const photoBy = room.state.photoBy ? players.find((p) => p.id === room.state.photoBy) : undefined;
  return (
    <div className="phone-center center-stack">
      {photoBy && <p className="dim">📸 Photo by {photoBy.name}</p>}
      {champ && (
        <>
          <p className="dim">Funniest caption</p>
          <h2>{champ.text}</h2>
          {champAuthor && <PlayerChip player={champAuthor} size="lg" />}
        </>
      )}
      {me2 ? (
        <p className="points big-num">+{me2.count * CAP_VOTE_POINTS + (won ? CAP_WIN_BONUS : 0)}</p>
      ) : (
        <p className="dim">You did not caption this one.</p>
      )}
    </div>
  );
}

/** Optional round-1 step: take or pick a photo that may be shown for everyone to caption. */
function PhotoUpload({ room, me, api }: Pick<PhoneGameProps, 'room' | 'me' | 'api'>) {
  const mine = api.mySubs.find((s) => s.kind === 'photo');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  const send = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await downscale(file, 1600, 0.82);
      const path = `${me.user_id}/caption/${room.current_run_id}/${randomId()}.jpg`;
      const up = await supabase.storage.from(PLAYER_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      await api.submit('photo', { path });
      setFile(null);
    } catch (e) {
      setErr(errorCode(e) === 'NOT_ACCEPTING' ? 'Too late, the photo step is over.' : errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap">
      <h2 className="center">📸 Add a photo</h2>
      <p className="center dim">Something funny, weird or random. It may show up on the TV for everyone to caption. Keep it friendly!</p>
      {mine && !file && (
        <div className="card center-stack">
          <h3>✅ Your photo is in</h3>
          <p className="dim small">Pick another below to replace it.</p>
        </div>
      )}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <input ref={library} type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <div className="row gap">
        <button className="btn btn-lg grow" onClick={() => camera.current?.click()}>📷 Take a photo</button>
        <button className="btn btn-lg grow" onClick={() => library.current?.click()}>🖼️ Choose one</button>
      </div>
      {preview && <img className="cap-thumb" src={preview} alt="Your photo" />}
      <button className="btn btn-primary btn-lg" disabled={busy || !file} onClick={() => void send()}>
        {busy ? 'Uploading…' : mine ? 'Replace my photo' : 'Use this photo'}
      </button>
      {err && <p className="error center">{err}</p>}
      <p className="center dim small">This step is optional. Waiting for the host to start.</p>
    </div>
  );
}
