-- Teams layer: teams persist for the night; players optionally belong to one.
-- Non-team games ignore all of this.

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now()
);
create index teams_room_idx on public.teams (room_id);

-- Deleting a team just un-teams its players.
alter table public.players add column if not exists team_id uuid references public.teams (id) on delete set null;

alter table public.teams enable row level security;

-- Anyone in the app may see teams (names/colors are public); only the host changes them.
-- Phones cannot change players.team_id: players already has no phone write policy.
create policy teams_read on public.teams for select to authenticated using (true);
create policy teams_host on public.teams for all to authenticated
  using (public.is_host()) with check (public.is_host());

revoke all on public.teams from anon;

alter publication supabase_realtime add table public.teams;
