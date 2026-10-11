-- Talent Show: bank of absurd talents handed out at random. Host-only like other banks.
create table if not exists public.talents (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  created_at timestamptz not null default now()
);

alter table public.talents enable row level security;

create policy talents_host on public.talents for all to authenticated
  using (public.is_host()) with check (public.is_host());

revoke all on public.talents from anon;
