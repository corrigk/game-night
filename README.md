# Party Pack 🎉

A Jackbox-style party game night: one computer drives the TV, everyone plays on their phone.
Built with Vite + React + TypeScript and Supabase (Realtime, Postgres, Storage, anonymous auth).

| Route    | Who          | What                                                              |
| -------- | ------------ | ----------------------------------------------------------------- |
| `/`      | The TV       | Game engine + big-screen display. Hidden host drawer (`H`).        |
| `/play`  | Every phone  | Join with the room code / QR and play.                            |
| `/admin` | Host         | Edit prompt banks, import seed JSON (caption photo upload: step 4) |

## Build status

- [x] 1. Scaffold, schema, join flow, reconnect, hub, host drawer, themes (+ **Tap Race** warm-up to test the engine)
- [x] 2. Most Likely To
- [ ] 3. Weird Facts
- [ ] 4. Caption This + admin image upload
- [ ] 5. Story Chain
- [ ] 6. Zillow Hunt
- [ ] 7. Awards, polish, sounds, rehearsal checklist

---

## Setup

### 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Sign In / Providers → enable "Allow anonymous sign-ins".**
3. **SQL Editor** → paste the contents of `supabase/migrations/20261011000000_init.sql` → Run.
   (Or with the Supabase CLI: `supabase link` then `supabase db push`.)
4. Still in the SQL editor, set the **host passcode** (used by the TV and `/admin`):

   ```sql
   select private.set_host_passcode('pick-something-good');
   ```

   Run it again any time to change it. Only a bcrypt hash is stored.

5. Optional, for big groups on one Wi-Fi: **Authentication → Rate Limits** → raise
   "anonymous sign-ins per hour" (default 30 per IP). Each phone signs in once per night.

### 2. Local config

```bash
cp .env.example .env
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from **Project Settings → API**
(the anon / publishable key). **Never** put the service-role / secret key in this project.

### 3. Run it

```bash
npm install
npm run dev
```

Vite prints a `Network:` URL like `http://192.168.1.20:5173`. **Open the TV page using that
address**, not `localhost`, so the QR code points somewhere phones can reach. Phones must be on
the same Wi-Fi.

### 4. Deploy (Vercel)

Import the GitHub repo in Vercel, add the two `VITE_SUPABASE_*` env vars, deploy. `vercel.json`
already rewrites `/play` and `/admin` to the SPA. On game night, open the deployed `/` on the TV
computer; phones can be on any network.

---

## Content

Prompt banks live in Supabase, not in the repo, so friends can't read the answers on GitHub.

- `/admin` → pick a bank → add/edit rows, or paste/upload JSON.
- `/admin` → **Import everything** takes one JSON object with any of these keys:
  `most_likely_prompts`, `facts`, `caption_cards`, `story_seeds`, `zillow_prompts`.
  See [`sample-data/sample-seed.json`](sample-data/sample-seed.json) for the format.
- Keep your real seed files in `/seed/` (gitignored), e.g. `seed/party.json`.
- Fact answers are hidden in `/admin` unless you tick "Show answers", because you're playing too.

---

## Running a game night

1. Open `/` on the TV computer. Enter the host passcode once (it's remembered on that browser).
2. The lobby shows a QR code and a 4-letter room code. Everyone scans and taps their name, then
   picks an emoji and a color. Late joiners can scan the corner QR any time.
3. Join on your own phone too: the host is also a player.
4. Press `Space` to open the **game hub**. Click a game, choose the number of rounds, Start.
5. Each game goes **intro → rounds → results → hub**. Pick any game in any order; the
   leaderboard is cumulative for the whole night.
6. Press `H` for host controls whenever something needs fixing.

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

Next · Skip prompt · +15s · +1 round · End game early (keeps points, shows results) ·
Back to hub (confirm; keeps points) · Kick player · Theme switcher (5 themes, phones follow) ·
Sound on/off (muted by default) · Edit the join roster · New room.

---

## Testing on one computer

Every browser tab shares one identity by default. Add `&as=2`, `&as=3`, … to a phone URL to give
that tab its own identity, e.g. `http://localhost:5173/play?code=BCDF&as=2`. Open a few tabs to
simulate a room. (Use an incognito window if you want a "clean" phone.)

---

## How it works

- **The TV is the source of truth.** Only the TV writes `rooms.phase / current_game / round /
  state / timer_ends_at`. Phones subscribe to their room row via Supabase Realtime and render
  by phase. Every screen refetches on reconnect, focus, and every 20s, so nothing gets stuck.
- **Timers** are server timestamps; every client estimates its clock offset from the server.
- **Phones write only through RPCs** (`join_room`, `submit`, `cast_vote`, …). `submit` and
  `cast_vote` only accept the input kinds the engine has opened in `rooms.state.accept`, for the
  current run and round, so late or spoofed answers are rejected by the database.
- **Row Level Security:** phones can read rooms, players and score events. They can only read
  their *own* submissions and votes. Content tables (including fact answers), `game_runs`
  (engine-private state), and everyone else's submissions are host-only. A device becomes a
  host by calling `claim_host(passcode)`, which checks a bcrypt hash in a private schema.
- **Scoring** is an append-only `score_events` log; `players.score` is maintained by a trigger.

> Why is the passcode in the database instead of a `VITE_` env var? Anything with a `VITE_`
> prefix is baked into the public JavaScript bundle, so anyone could read it. Storing a hash in
> Postgres keeps it secret and also gates the answer keys at the database level.

### Adding a game

1. Create `src/games/<name>/` with a `GameModule` (see [`src/games/types.ts`](src/games/types.ts)):
   metadata, `startRound`, `next`, optional `onTimerEnd` / `ready` / `skip`, plus `TV` and `Phone`
   components.
2. Add it to `GAME_LIST` in [`src/games/registry.ts`](src/games/registry.ts).

No schema changes: per-round input goes in `submissions.payload` (with a `kind`), public step
state in `rooms.state`, private engine state in `game_runs.state`. [`Tap Race`](src/games/taprace/tapRace.tsx)
is a complete minimal example.

---

## Public-repo hygiene

- `.env` is gitignored; only `.env.example` (placeholders) is committed.
- No service-role key anywhere in this project.
- `/seed/` and `/photos/` are gitignored. Friend photos go to the Supabase `caption-images`
  bucket via `/admin` only.
- Only small sample content lives in `sample-data/`.
