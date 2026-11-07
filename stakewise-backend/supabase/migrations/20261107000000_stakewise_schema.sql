-- Stakewise schema. Row-level security: users only see their own rows.
-- Edge functions use the service role and enforce user scoping in code.

create table if not exists public.profiles (
  id uuid primary key,                       -- = auth.users.id (or the seeded demo user)
  first_name text,
  language text not null default 'English',
  plain_language boolean not null default true,
  current_balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  posted_at timestamptz not null,
  amount numeric(12,2) not null,             -- negative = money out
  description text not null,
  mcc text,
  created_at timestamptz not null default now()
);
create index if not exists transactions_user_time on public.transactions(user_id, posted_at);

create table if not exists public.classifications (
  transaction_id uuid primary key references public.transactions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  label text not null check (label in ('gambling','ask_user','not_gambling')),
  category text not null,
  confidence numeric(4,3) not null,
  reasons jsonb not null default '[]',
  source text not null check (source in ('rules','llm','user')),
  updated_at timestamptz not null default now()
);

create table if not exists public.merchant_feedback (
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_key text not null,
  is_gambling boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, merchant_key)
);

create table if not exists public.limits (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  weekly_gambling_limit numeric(10,2),
  per_bet_max numeric(10,2),
  self_exclusion_until timestamptz,
  pending_increase jsonb,                    -- raised limits wait 48h
  pending_effective_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Append-only audit log of every stake check
create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text,
  market_title text,
  inputs jsonb not null,
  result jsonb not null,
  rules_version text not null,
  created_at timestamptz not null default now()
);

create or replace function public.prevent_audit_changes() returns trigger language plpgsql as $$
begin
  raise exception 'checks is append-only';
end $$;
drop trigger if exists checks_append_only on public.checks;
create trigger checks_append_only before update or delete on public.checks
  for each row execute function public.prevent_audit_changes();

create table if not exists public.coach_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  facts jsonb not null,
  message jsonb not null,
  created_at timestamptz not null default now()
);

-- RLS
alter table public.profiles enable row level security;
alter table public.transactions enable row level security;
alter table public.classifications enable row level security;
alter table public.merchant_feedback enable row level security;
alter table public.limits enable row level security;
alter table public.checks enable row level security;
alter table public.coach_messages enable row level security;

create policy "own profile" on public.profiles for select using (id = auth.uid());
create policy "own transactions" on public.transactions for select using (user_id = auth.uid());
create policy "own classifications" on public.classifications for select using (user_id = auth.uid());
create policy "own feedback" on public.merchant_feedback for select using (user_id = auth.uid());
create policy "own limits" on public.limits for select using (user_id = auth.uid());
create policy "own checks" on public.checks for select using (user_id = auth.uid());
create policy "own coach messages" on public.coach_messages for select using (user_id = auth.uid());
