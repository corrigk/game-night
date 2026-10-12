-- Content for Acronym Attack, Plot Twist and Mad Libs Theatre, plus a `headline` photo pool for
-- Fake Headlines. All host-only. Mad Libs script text never reaches phones: each cast member gets
-- a private 'role' row (RLS: only that player can read it) containing only their own lines.

create table public.acronym_themes (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  created_at timestamptz not null default now(),
  times_used int not null default 0,
  last_used_at timestamptz,
  vetoed boolean not null default false
);

create table public.plot_twist_setups (
  id uuid primary key default gen_random_uuid(),
  setup text not null,
  genre text,
  created_at timestamptz not null default now(),
  times_used int not null default 0,
  last_used_at timestamptz,
  vetoed boolean not null default false
);

-- `slug` is the template's id from the import file. mode 'script' now; 'story' is reserved for later.
create table public.madlibs_templates (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  title text not null,
  mode text not null default 'script' check (mode in ('script', 'story')),
  description text,
  roles jsonb not null default '[]'::jsonb,
  blanks jsonb not null default '[]'::jsonb,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  times_used int not null default 0,
  last_used_at timestamptz,
  vetoed boolean not null default false
);

alter table public.acronym_themes enable row level security;
alter table public.plot_twist_setups enable row level security;
alter table public.madlibs_templates enable row level security;

create policy acronym_themes_host on public.acronym_themes for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy plot_twist_setups_host on public.plot_twist_setups for all to authenticated
  using (public.is_host()) with check (public.is_host());
create policy madlibs_templates_host on public.madlibs_templates for all to authenticated
  using (public.is_host()) with check (public.is_host());

revoke all on public.acronym_themes, public.plot_twist_setups, public.madlibs_templates from anon;

-- New photo pool for Fake Headlines.
alter table public.caption_images drop constraint if exists caption_images_pool_check;
alter table public.caption_images
  add constraint caption_images_pool_check check (pool in ('generic', 'friends', 'headline'));

create or replace function public.bump_used(p_table text, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_host() then raise exception 'NOT_HOST'; end if;
  if p_table not in ('facts', 'most_likely_prompts', 'caption_cards', 'caption_images',
                     'story_seeds', 'zillow_prompts', 'talents',
                     'emoji_titles', 'dolphin_tasks', 'hot_seat_words',
                     'acronym_themes', 'plot_twist_setups', 'madlibs_templates') then
    raise exception 'BAD_TABLE';
  end if;
  execute format('update public.%I set times_used = times_used + 1, last_used_at = now() where id = any($1)', p_table)
    using p_ids;
end $$;
