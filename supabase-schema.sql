create table if not exists collectors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  area text not null,
  vehicle text not null,
  created_at timestamptz not null default now()
);

create table if not exists pickup_requests (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  phone text not null,
  address text not null,
  plastic_type text not null,
  weight numeric not null,
  slot text not null,
  notes text not null default '',
  status text not null default 'Searching collector',
  estimated_reward integer not null default 0,
  assigned_collector_id uuid references collectors(id),
  assigned_collector_name text,
  assigned_collector_phone text,
  assigned_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists research_ideas (
  id uuid primary key default gen_random_uuid(),
  contributor text not null,
  focus text not null,
  idea text not null,
  created_at timestamptz not null default now()
);

alter table collectors enable row level security;
alter table pickup_requests enable row level security;
alter table research_ideas enable row level security;

-- The Node backend uses the service role key, so public browser access can stay blocked.
-- Add public/authenticated policies later only if you intentionally connect Supabase directly from the frontend.
