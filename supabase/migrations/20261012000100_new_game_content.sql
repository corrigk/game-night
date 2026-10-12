-- Content banks for Emoji Translation, Dolphin and Hot Seat. Host-only like every other bank:
-- phones never read these tables. Emoji answers, Dolphin tasks and Hot Seat forbidden words only
-- reach a phone through per-player private rows ('secret', 'task', 'card') the TV writes,
-- which RLS lets only that player read.

create table public.emoji_titles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,           -- movies | bible | saints | songs | foods | tv
  created_at timestamptz not null default now(),
  times_used int not null default 0,
  last_used_at timestamptz,
  vetoed boolean not null default false
);

create table public.dolphin_tasks (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  created_at timestamptz not null default now(),
  times_used int not null default 0,
  last_used_at timestamptz,
  vetoed boolean not null default false
);

create table public.hot_seat_words (
  id uuid primary key default gen_random_uuid(),
  word text not null,
  forbidden text[] not null default '{}',
  category text not null default 'things',
  created_at timestamptz not null default now(),
  times_used int not null default 0,
  last_used_at timestamptz,
  vetoed boolean not null default false
);

alter table public.emoji_titles enable row level security;
alter table public.dolphin_tasks enable row level security;
alter table public.hot_seat_words enable row level security;

create policy emoji_titles_host on public.emoji_titles for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy dolphin_tasks_host on public.dolphin_tasks for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy hot_seat_words_host on public.hot_seat_words for all to authenticated
  using (public.is_host()) with check (public.is_host());

revoke all on public.emoji_titles, public.dolphin_tasks, public.hot_seat_words from anon;

-- Teach the usage counter about the new banks.
create or replace function public.bump_used(p_table text, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_host() then raise exception 'NOT_HOST'; end if;
  if p_table not in ('facts', 'most_likely_prompts', 'caption_cards', 'caption_images',
                     'story_seeds', 'zillow_prompts', 'talents',
                     'emoji_titles', 'dolphin_tasks', 'hot_seat_words') then
    raise exception 'BAD_TABLE';
  end if;
  execute format('update public.%I set times_used = times_used + 1, last_used_at = now() where id = any($1)', p_table)
    using p_ids;
end $$;
