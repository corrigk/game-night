-- Party Pack: initial schema
--
-- Security model
--   * Everyone (TV, phones, admin) signs in with Supabase anonymous auth.
--   * A user becomes a "host" by calling claim_host(passcode). Hosts are the TV
--     engine and the /admin page. Only hosts can read answer keys, other players'
--     submissions, and engine-private state.
--   * Phones read rooms + players (public state only) and write exclusively through
--     the SECURITY DEFINER RPCs below, which validate who they are and what the
--     room is currently accepting.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Private schema: host list + config. Not exposed to the API roles.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.hosts (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);

create table private.config (
  key text primary key,
  value text not null
);

-- Run once from the Supabase SQL editor:  select private.set_host_passcode('your-passcode');
create or replace function private.set_host_passcode(p_passcode text) returns void
language sql security definer set search_path = '' as $$
  insert into private.config (key, value)
  values ('host_passcode_hash', extensions.crypt(p_passcode, extensions.gen_salt('bf')))
  on conflict (key) do update set value = excluded.value;
$$;

create or replace function public.is_host() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.hosts where user_id = auth.uid());
$$;

create or replace function public.claim_host(p_passcode text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  select value into v_hash from private.config where key = 'host_passcode_hash';
  if v_hash is null then raise exception 'NO_PASSCODE_SET'; end if;
  if extensions.crypt(p_passcode, v_hash) <> v_hash then
    perform pg_sleep(1); -- slow down guessing
    return false;
  end if;
  insert into private.hosts (user_id) values (auth.uid()) on conflict do nothing;
  return true;
end $$;

create or replace function public.server_now() returns timestamptz
language sql stable as $$ select now(); $$;

-- ---------------------------------------------------------------------------
-- Core game tables
-- ---------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z]{4}$'),
  host_uid uuid not null default auth.uid(),
  phase text not null default 'lobby',          -- lobby | hub | intro | play | results | awards
  current_game text,
  current_run_id uuid,
  round int not null default 0,
  rounds_total int not null default 0,
  state jsonb not null default '{}'::jsonb,       -- PUBLIC display state for the current step
  timer_ends_at timestamptz,
  timer_duration int,
  settings jsonb not null default '{}'::jsonb,    -- theme, roster, etc.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null,
  name text not null check (char_length(name) between 1 and 24),
  emoji text not null check (char_length(emoji) between 1 and 16),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  score int not null default 0,
  connected boolean not null default true,
  joined_at timestamptz not null default now()
);
create unique index players_room_name_uq on public.players (room_id, lower(name));
create unique index players_room_color_uq on public.players (room_id, lower(color));
create index players_user_idx on public.players (user_id);

create table public.game_runs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  game_type text not null,
  status text not null default 'intro',           -- intro | playing | results | done | exited
  config jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,       -- engine-PRIVATE state (host only)
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index game_runs_room_idx on public.game_runs (room_id);

alter table public.rooms
  add constraint rooms_current_run_fk foreign key (current_run_id)
  references public.game_runs (id) on delete set null;

-- Generic per-round input from players. `kind` lets a game have several kinds of
-- input per round (e.g. 'fake', 'caption', 'pitch') without schema changes.
-- player_id is null for system rows (e.g. the real answer in Weird Facts).
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  run_id uuid not null references public.game_runs (id) on delete cascade,
  round int not null,
  kind text not null default 'main',
  player_id uuid references public.players (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index submissions_one_per_player
  on public.submissions (run_id, round, kind, player_id) where player_id is not null;
create index submissions_room_idx on public.submissions (room_id);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  run_id uuid not null references public.game_runs (id) on delete cascade,
  round int not null,
  kind text not null default 'main',
  voter_id uuid not null references public.players (id) on delete cascade,
  target_submission_id uuid references public.submissions (id) on delete cascade,
  target_player_id uuid references public.players (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (run_id, round, kind, voter_id),
  check (target_submission_id is not null or target_player_id is not null)
);
create index votes_room_idx on public.votes (room_id);

-- Auditable points. players.score is a cache maintained by trigger.
create table public.score_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  run_id uuid references public.game_runs (id) on delete set null,
  points int not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index score_events_room_idx on public.score_events (room_id);

-- ---------------------------------------------------------------------------
-- Content banks (host-only; answers never reach phones)
-- ---------------------------------------------------------------------------
create table public.facts (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,          -- use ___ for the blank
  answer text not null,
  blurb text,
  kind text not null default 'short' check (kind in ('short', 'phrase')),
  created_at timestamptz not null default now()
);

create table public.most_likely_prompts (
  id uuid primary key default gen_random_uuid(),
  text text not null,            -- "...forget their own birthday"
  created_at timestamptz not null default now()
);

create table public.caption_images (
  id uuid primary key default gen_random_uuid(),
  url text,                      -- external URL (generic pool)
  storage_path text,             -- path in the caption-images bucket (friends pool)
  pool text not null default 'generic' check (pool in ('generic', 'friends')),
  credit text,
  created_at timestamptz not null default now(),
  check (url is not null or storage_path is not null)
);

create table public.caption_cards (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  created_at timestamptz not null default now()
);

create table public.story_seeds (
  id uuid primary key default gen_random_uuid(),
  genre text not null,
  opening_line text not null,
  created_at timestamptz not null default now()
);

create table public.zillow_prompts (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('wildcard', 'filter', 'weird')),
  location text not null,
  prompt text,                   -- "coolest listing", "most haunted-looking house"
  filters text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger rooms_updated_at before update on public.rooms
  for each row execute function public.tg_set_updated_at();
create trigger submissions_updated_at before update on public.submissions
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_apply_score_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.players set score = score + new.points where id = new.player_id;
    return new;
  else
    update public.players set score = score - old.points where id = old.player_id;
    return old;
  end if;
end $$;

create trigger score_events_apply after insert or delete on public.score_events
  for each row execute function public.tg_apply_score_event();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.game_runs enable row level security;
alter table public.submissions enable row level security;
alter table public.votes enable row level security;
alter table public.score_events enable row level security;
alter table public.facts enable row level security;
alter table public.most_likely_prompts enable row level security;
alter table public.caption_images enable row level security;
alter table public.caption_cards enable row level security;
alter table public.story_seeds enable row level security;
alter table public.zillow_prompts enable row level security;

-- Public-to-players state
create policy rooms_read on public.rooms for select to authenticated using (true);
create policy rooms_host on public.rooms for all to authenticated
  using (public.is_host()) with check (public.is_host());

create policy players_read on public.players for select to authenticated using (true);
create policy players_host on public.players for all to authenticated
  using (public.is_host()) with check (public.is_host());

create policy score_events_read on public.score_events for select to authenticated using (true);
create policy score_events_host on public.score_events for all to authenticated
  using (public.is_host()) with check (public.is_host());

-- Host-only (engine state, content, answer keys)
create policy game_runs_host on public.game_runs for all to authenticated
  using (public.is_host()) with check (public.is_host());

-- Submissions/votes: hosts see everything; a phone sees only its own rows.
create policy submissions_host on public.submissions for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy submissions_own on public.submissions for select to authenticated
  using (exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid()));

create policy votes_host on public.votes for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy votes_own on public.votes for select to authenticated
  using (exists (select 1 from public.players p where p.id = voter_id and p.user_id = auth.uid()));

create policy facts_host on public.facts for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy most_likely_prompts_host on public.most_likely_prompts for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy caption_images_host on public.caption_images for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy caption_cards_host on public.caption_cards for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy story_seeds_host on public.story_seeds for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy zillow_prompts_host on public.zillow_prompts for all to authenticated
  using (public.is_host()) with check (public.is_host());

-- Nothing for the bare anon role (not signed in at all).
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Host creates a room with a fresh 4-letter code (consonants only: no accidental words).
create or replace function public.create_room(p_settings jsonb default '{}'::jsonb)
returns public.rooms
language plpgsql security definer set search_path = '' as $$
declare
  v_letters constant text := 'BCDFGHJKLMNPQRSTVWXZ';
  v_code text;
  v_room public.rooms;
begin
  if not public.is_host() then raise exception 'NOT_HOST'; end if;
  loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_letters, 1 + floor(random() * length(v_letters))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;
  insert into public.rooms (code, host_uid, settings)
  values (v_code, auth.uid(), coalesce(p_settings, '{}'::jsonb))
  returning * into v_room;
  return v_room;
end $$;

-- Phone joins (or re-joins with a new look) as the signed-in anonymous user.
create or replace function public.join_room(p_code text, p_name text, p_emoji text, p_color text)
returns public.players
language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_me public.players;
  v_name text := btrim(coalesce(p_name, ''));
  v_max int;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  select * into v_room from public.rooms where code = upper(btrim(p_code));
  if v_room.id is null then raise exception 'ROOM_NOT_FOUND'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 24 then raise exception 'BAD_NAME'; end if;

  select * into v_me from public.players where room_id = v_room.id and user_id = auth.uid();

  if exists (select 1 from public.players
             where room_id = v_room.id and lower(name) = lower(v_name)
               and id is distinct from v_me.id) then
    raise exception 'NAME_TAKEN';
  end if;
  if exists (select 1 from public.players
             where room_id = v_room.id and lower(color) = lower(p_color)
               and id is distinct from v_me.id) then
    raise exception 'COLOR_TAKEN';
  end if;

  if v_me.id is not null then
    update public.players set name = v_name, emoji = p_emoji, color = p_color, connected = true
    where id = v_me.id returning * into v_me;
    return v_me;
  end if;

  v_max := coalesce((v_room.settings ->> 'maxPlayers')::int, 20);
  if (select count(*) from public.players where room_id = v_room.id) >= v_max then
    raise exception 'ROOM_FULL';
  end if;

  insert into public.players (room_id, user_id, name, emoji, color)
  values (v_room.id, auth.uid(), v_name, p_emoji, p_color)
  returning * into v_me;
  return v_me;
end $$;

-- Phone changes its own emoji/color.
create or replace function public.update_me(p_player_id uuid, p_emoji text, p_color text)
returns public.players
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.players;
begin
  select * into v_me from public.players where id = p_player_id and user_id = auth.uid();
  if v_me.id is null then raise exception 'NOT_YOUR_PLAYER'; end if;
  if exists (select 1 from public.players
             where room_id = v_me.room_id and lower(color) = lower(p_color) and id <> v_me.id) then
    raise exception 'COLOR_TAKEN';
  end if;
  update public.players set emoji = p_emoji, color = p_color
  where id = v_me.id returning * into v_me;
  return v_me;
end $$;

-- "That's me on a new phone": move an existing player to this device.
-- Trust-based by design (it's a party). The old device notices and signs out.
create or replace function public.reclaim_player(p_player_id uuid)
returns public.players
language plpgsql security definer set search_path = '' as $$
declare
  v_target public.players;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  select * into v_target from public.players where id = p_player_id;
  if v_target.id is null then raise exception 'PLAYER_NOT_FOUND'; end if;
  delete from public.players
  where room_id = v_target.room_id and user_id = auth.uid() and id <> v_target.id;
  update public.players set user_id = auth.uid(), connected = true
  where id = v_target.id returning * into v_target;
  return v_target;
end $$;

-- Phone submits input for the current run/round. The engine opens and closes
-- input by setting rooms.state.accept.submit = ['kind', ...].
create or replace function public.submit(p_room_id uuid, p_kind text, p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_me public.players;
  v_id uuid;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if v_room.id is null then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into v_me from public.players where room_id = p_room_id and user_id = auth.uid();
  if v_me.id is null then raise exception 'NOT_IN_ROOM'; end if;
  if v_room.current_run_id is null
     or not coalesce((v_room.state -> 'accept' -> 'submit') ? p_kind, false) then
    raise exception 'NOT_ACCEPTING';
  end if;
  if pg_column_size(p_payload) > 8000 then raise exception 'TOO_LARGE'; end if;

  insert into public.submissions (room_id, run_id, round, kind, player_id, payload)
  values (p_room_id, v_room.current_run_id, v_room.round, p_kind, v_me.id, coalesce(p_payload, '{}'::jsonb))
  on conflict (run_id, round, kind, player_id) where player_id is not null
  do update set payload = excluded.payload
  returning id into v_id;
  return v_id;
end $$;

-- Phone votes for a submission (never its own) or for a player (self allowed).
-- Open via rooms.state.accept.vote = ['kind', ...].
create or replace function public.cast_vote(
  p_room_id uuid, p_kind text,
  p_target_submission_id uuid default null, p_target_player_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_me public.players;
  v_sub public.submissions;
  v_id uuid;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if v_room.id is null then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into v_me from public.players where room_id = p_room_id and user_id = auth.uid();
  if v_me.id is null then raise exception 'NOT_IN_ROOM'; end if;
  if v_room.current_run_id is null
     or not coalesce((v_room.state -> 'accept' -> 'vote') ? p_kind, false) then
    raise exception 'NOT_ACCEPTING';
  end if;
  if (p_target_submission_id is null) = (p_target_player_id is null) then
    raise exception 'BAD_TARGET';
  end if;

  if p_target_submission_id is not null then
    select * into v_sub from public.submissions where id = p_target_submission_id;
    if v_sub.id is null or v_sub.run_id <> v_room.current_run_id then raise exception 'BAD_TARGET'; end if;
    if v_sub.player_id = v_me.id then raise exception 'OWN_SUBMISSION'; end if;
  else
    if not exists (select 1 from public.players where id = p_target_player_id and room_id = p_room_id) then
      raise exception 'BAD_TARGET';
    end if;
  end if;

  insert into public.votes (room_id, run_id, round, kind, voter_id, target_submission_id, target_player_id)
  values (p_room_id, v_room.current_run_id, v_room.round, p_kind, v_me.id, p_target_submission_id, p_target_player_id)
  on conflict (run_id, round, kind, voter_id)
  do update set target_submission_id = excluded.target_submission_id,
                target_player_id = excluded.target_player_id,
                created_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- Trigger functions are never called directly.
revoke execute on function public.tg_set_updated_at() from public, anon, authenticated;
revoke execute on function public.tg_apply_score_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.rooms, public.players, public.submissions, public.votes, public.score_events;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('caption-images', 'caption-images', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('zillow-screenshots', 'zillow-screenshots', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

-- caption-images: host only (TV gets signed URLs)
create policy caption_images_host_all on storage.objects for all to authenticated
  using (bucket_id = 'caption-images' and public.is_host())
  with check (bucket_id = 'caption-images' and public.is_host());

-- zillow-screenshots: players upload into a folder named after their auth uid
create policy zillow_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'zillow-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
create policy zillow_read_own on storage.objects for select to authenticated
  using (bucket_id = 'zillow-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
create policy zillow_host_all on storage.objects for all to authenticated
  using (bucket_id = 'zillow-screenshots' and public.is_host())
  with check (bucket_id = 'zillow-screenshots' and public.is_host());
