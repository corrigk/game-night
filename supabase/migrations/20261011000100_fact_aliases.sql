-- Alternate accepted spellings of a fact's real answer. Used by the engine to reject
-- fake answers that are really the truth. Host-only like the rest of `facts`.
alter table public.facts add column if not exists aliases text[] not null default '{}';
