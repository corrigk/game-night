-- Prompt usage tracking + host veto, so repeat game nights don't repeat prompts and a
-- flop of a prompt can be retired on the spot. Host-only like the rest of the banks.

alter table public.facts               add column if not exists times_used int not null default 0, add column if not exists last_used_at timestamptz, add column if not exists vetoed boolean not null default false;
alter table public.most_likely_prompts add column if not exists times_used int not null default 0, add column if not exists last_used_at timestamptz, add column if not exists vetoed boolean not null default false;
alter table public.caption_cards       add column if not exists times_used int not null default 0, add column if not exists last_used_at timestamptz, add column if not exists vetoed boolean not null default false;
alter table public.caption_images      add column if not exists times_used int not null default 0, add column if not exists last_used_at timestamptz, add column if not exists vetoed boolean not null default false;
alter table public.story_seeds         add column if not exists times_used int not null default 0, add column if not exists last_used_at timestamptz, add column if not exists vetoed boolean not null default false;
alter table public.zillow_prompts      add column if not exists times_used int not null default 0, add column if not exists last_used_at timestamptz, add column if not exists vetoed boolean not null default false;
alter table public.talents             add column if not exists times_used int not null default 0, add column if not exists last_used_at timestamptz, add column if not exists vetoed boolean not null default false;

-- Atomic "this was used" counter. Hosts only; the table name is whitelisted.
create or replace function public.bump_used(p_table text, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_host() then raise exception 'NOT_HOST'; end if;
  if p_table not in ('facts', 'most_likely_prompts', 'caption_cards', 'caption_images',
                     'story_seeds', 'zillow_prompts', 'talents') then
    raise exception 'BAD_TABLE';
  end if;
  execute format('update public.%I set times_used = times_used + 1, last_used_at = now() where id = any($1)', p_table)
    using p_ids;
end $$;

revoke execute on function public.bump_used(text, uuid[]) from public, anon;
grant execute on function public.bump_used(text, uuid[]) to authenticated;
