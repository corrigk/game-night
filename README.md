# Party Pack 🎉

A Jackbox-style party game night: one computer drives the TV, everyone plays on their phone.
Built with Vite + React + TypeScript and Supabase (Realtime, Postgres, Storage, anonymous auth).

| Route    | Who          | What                                                                    |
| -------- | ------------ | ----------------------------------------------------------------------- |
| `/`      | The TV       | Game engine + big-screen display. Hidden host drawer (`H`).              |
| `/play`  | Every phone  | Join with the room code / QR and play.                                  |
| `/admin` | Host         | Edit prompt banks, import seed JSON, upload caption photos.             |

## The games

| Game | Scored | How it plays |
| ---- | ------ | ------------ |
| 👉 **Most Likely To** | yes | A prompt appears; everyone votes for a player (self-vote allowed). Reveal with counts. Voters who match the majority score. |
| 🧐 **Weird Facts** | yes | Write a fake answer to a real fact (answers matching the truth, or each other, are bounced back for a retry), vote for the truth, then count through the picks. Find the truth +300, fool a player +150 each. |
| 🖼️ **Caption This** | yes | A photo is on the TV. Each phone has a private 7-card hand plus a write-your-own slot. Anonymous vote, winner revealed. |
| 📜 **Story Chain** | no | Everyone starts a story (genre + opening line). Each round the stories rotate and you see only the last line. Finale: each person reads the story they started while the TV scrolls it, then reveals authors by color. |
| 🏠 **Zillow Hunt** | yes | Search Zillow on your own phone, submit a link + 1-3 screenshots. Anonymous gallery vote, top 3 pitch for 45s, final vote. "Call it out" on filter rounds; the host rules. Nothing is scraped or embedded. |
| 🎭 **Talent Show** | yes | Everyone is secretly assigned an absurd talent they cannot do and gets 2 minutes to prepare, then performs live. The audience rates 1-5 stars. |
| ⚡ **Tap Race** | yes | A 30-second warm-up. Great for checking everyone's phone works. |

At the end of the night, **Final Awards** on the hub shows the podium and silly superlatives
(Best Liar, Human Lie Detector, Funniest Caption, Most Likely Winner, Mind Reader, Quickest Draw,
Dream Home Hunter, Star Performer, Participation Trophy).

---

## Setup

### 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Sign In / Providers → enable "Allow anonymous sign-ins".**
3. **SQL Editor** → run each file in `supabase/migrations/`, **in order, once each**:
   1. `20261011000000_init.sql`
   2. `20261011000100_fact_aliases.sql`
   3. `20261011000200_talents.sql`

   (Or with the Supabase CLI: `supabase link` then `supabase db push`.) Running a file twice
   fails harmlessly with "already exists"; just skip it.
4. Set the **host passcode** (used by the TV and `/admin`). Run only this line:

   ```sql
   select private.set_host_passcode('pick-something-good');
   ```

   Run it again any time to change it. Only a bcrypt hash is stored.

5. For big groups on one Wi-Fi: **Authentication → Rate Limits** → raise
   "anonymous sign-ins per hour" (default 30 per IP). Each phone signs in once per night.

### 2. Local config

```bash
cp .env.example .env
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from **Project Settings → API**
(the anon key). **Never** put the service-role / secret key in this project.

### 3. Run it

```bash
npm install
npm run dev
```

Vite prints a `Network:` URL like `http://192.168.1.20:5173`. **Open the TV page using that
address**, not `localhost`, so the QR code points somewhere phones can reach. Phones must be on
the same Wi-Fi. (Or just use the deployed site, below.)

### 4. Deploy (Vercel)

Import the GitHub repo in Vercel, add the two `VITE_SUPABASE_*` env vars, deploy. `vercel.json`
already rewrites `/play` and `/admin` to the SPA. On game night, open the deployed `/` on the TV
computer; phones can be on any network. Every push to `main` redeploys.

---

## Content

Prompt banks live in Supabase, not in the repo, so friends can't read the answers on GitHub.

- `/admin` → pick a bank → add/edit rows, or paste/upload JSON.
- `/admin` → **Import everything** takes one JSON object with any of these keys:
  `most_likely_prompts`, `facts`, `caption_cards`, `story_seeds`, `zillow_prompts`, `talents`.
  See [`sample-data/sample-seed.json`](sample-data/sample-seed.json) for the format.
- Keep your real seed files in `/seed/` (gitignored), e.g. `seed/party.json`.
- Fact answers are hidden in `/admin` unless you tick "Show answers", because you're playing too.
- Facts can list `aliases`: other spellings of the real answer that should also be rejected as fakes.
- **Caption photos** → `/admin` → *Caption photos*. Upload friend photos to the **friends** pool
  (private bucket, never in the repo). The **generic** pool is for everyone-safe images; with none
  added, 12 built-in placeholder pictures are used. The host drawer's slider sets how often a
  friends photo shows up (default 30%).
- Without any talents in the database, the Talent Show uses a built-in list.

---

## Running a game night

1. Open `/` on the TV computer. Enter the host passcode once (it's remembered on that browser).
2. The lobby shows a QR code and a 4-letter room code. Everyone scans and taps their name, then
   picks an emoji and a color. Late joiners can scan the corner QR any time.
3. Join on your own phone too: the host is also a player.
4. Press `Space` to open the **game hub**. Click a game, choose the number of rounds, Start.
5. Each game goes **intro → rounds → results → hub**. Pick any game in any order; the
   leaderboard is cumulative for the whole night.
6. When you're done, click **Final Awards** on the hub.
7. Press `H` for host controls whenever something needs fixing.

If a phone refreshes, locks, or dies, just reopen the page: it rejoins automatically. On a
different phone, tap your name and confirm "Yes, that's me" to move your spot and points over.
If the TV refreshes, it resumes the same room and the same step.

### Keyboard shortcuts (TV)

| Key     | Action                       |
| ------- | ---------------------------- |
| `H`     | Toggle the host drawer       |
| `Space` | Next (advance the game)      |
| `+`     | Add 15 seconds to the timer  |
| `Esc`   | Close a dialog               |

### Host drawer

Next · Skip prompt (deals a fresh prompt; in Story Chain's finale it skips the reading) · +15s ·
+1 round · End game early (keeps points, shows results) · Back to hub (confirm; keeps points) ·
Kick player · Theme switcher (5 themes, phones follow) · Sound on/off (muted by default) ·
Caption photo mix · Edit the join roster · **Hard reset** (brand-new room and code).

### Rounds to pick

Game defaults: Most Likely To 8, Weird Facts 6, Caption This 6, Story Chain 6, Zillow Hunt 3,
Talent Show 6. For the Talent Show, pick the number of players so everyone performs once.
Story Chain rounds should usually be no more than the number of players.

---

## Rehearsal checklist

Do this a day or two before, ideally with 3-4 friends on real phones.

**Setup**
- [ ] All three migrations ran; `select private.set_host_passcode(...)` ran; anonymous sign-ins on.
- [ ] Vercel deploy is green and `/`, `/play`, `/admin` all load.
- [ ] `/admin` → *Import everything* with your seed file; each bank shows the expected row count.
- [ ] Caption photos uploaded to the *friends* pool; they show up in a Caption This round.
- [ ] Anonymous sign-in rate limit raised if everyone is on one Wi-Fi.

**TV computer**
- [ ] Open the deployed `/` in a fullscreen browser; unlock with the passcode.
- [ ] Sound: press `H`, turn effects on, check the pop/sting/fanfare are audible (browsers need a click first).
- [ ] Pick a theme that reads well from across the room.

**Phones**
- [ ] Everyone can join by QR, pick a name/emoji/color. One person refreshes mid-lobby and rejoins.
- [ ] Lock a phone for 30 seconds, unlock, confirm it catches up.
- [ ] One person joins from a second phone with "Yes, that's me".

**Each game (one quick round each)**
- [ ] Tap Race: green button works, results show.
- [ ] Most Likely To: vote, reveal, majority points.
- [ ] Weird Facts: typing the real answer is rejected; a fake matching someone else's is rejected; truth + blurb reveal.
- [ ] Caption This: hands show 7 cards, write-your-own works, you can't vote for your own.
- [ ] Story Chain: 2-3 round run; skip a writer to see the placeholder line; check the finale reading and author colors.
- [ ] Zillow Hunt: upload real screenshots from a phone; gallery shows them; run a pitch and the final vote; test "Call it out" on a filter round.
- [ ] Talent Show: private talent on each phone, performance, star ratings.
- [ ] Back to hub mid-game keeps points; "End game early" shows results; +1 round and +15s work.
- [ ] Final Awards plays through to the hub.

**Fallbacks**
- If a phone is stuck, its owner reopens `/play`; if that fails, kick and rejoin from `H`.
- If the TV freezes, refresh it. The room and current step are restored.
- Worst case: **Hard reset** from the host drawer and have everyone rescan.

---

## How it works

- **The TV is the source of truth.** Only the TV writes `rooms.phase / current_game / round /
  state / timer_ends_at`. Phones subscribe to their room row via Supabase Realtime and render
  by phase. Every screen refetches on reconnect, focus, and every 20s, so nothing gets stuck.
- **Timers** are server timestamps; every client estimates its clock offset from the server.
- **Phones write only through RPCs** (`join_room`, `submit`, `cast_vote`, …). `submit` and
  `cast_vote` only accept the input kinds the engine has opened in `rooms.state.accept`, for the
  current run and round, and `cast_vote` refuses votes for your own submission.
- **Row Level Security:** phones can read rooms, players and score events. They can only read
  their *own* submissions and votes (which is how private hands, talents and story prompts reach
  one phone). Content tables (including fact answers), `game_runs` (engine-private state such as
  the real answer), and everyone else's submissions are host-only. A device becomes a host by
  calling `claim_host(passcode)`, which checks a bcrypt hash in a private schema.
- **Scoring** is an append-only `score_events` log; `players.score` is maintained by a trigger.

> Why is the passcode in the database instead of a `VITE_` env var? Anything with a `VITE_`
> prefix is baked into the public JavaScript, so anyone could read it. Storing a hash in
> Postgres keeps it secret and also gates the answer keys at the database level.

### Adding a game

1. Create `src/games/<name>/` with a `GameModule` (see [`src/games/types.ts`](src/games/types.ts)):
   metadata, `startRound`, `next`, optional `onTimerEnd` / `ready` / `skip` / `process` / `action`,
   plus `TV` and `Phone` components.
2. Add it to `GAME_LIST` in [`src/games/registry.ts`](src/games/registry.ts).

No schema changes: per-round input goes in `submissions.payload` (with a `kind`), public step
state in `rooms.state`, private engine state in `game_runs.state`. [`Tap Race`](src/games/taprace/tapRace.tsx)
is a complete minimal example.

---

## Testing on one computer

Every browser tab shares one identity by default. Add `&as=2`, `&as=3`, … to a phone URL to give
that tab its own identity, e.g. `http://localhost:5173/play?code=BCDF&as=2`. Open a few tabs to
simulate a room.

---

## Public-repo hygiene

- `.env` is gitignored; only `.env.example` (placeholders) is committed.
- No service-role key anywhere in this project.
- `/seed/` and `/photos/` are gitignored. Friend photos go to the Supabase `caption-images`
  bucket via `/admin` only. Zillow screenshots go to the private `zillow-screenshots` bucket.
- Only small sample content lives in `sample-data/`.
