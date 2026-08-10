create table if not exists public.team_posts (
  id uuid primary key,
  post_type text not null check (post_type in ('recruit', 'join')),
  status text not null default 'open' check (status in ('open', 'closed')),
  title text not null,
  artist_name text not null,
  primary_field text not null,
  region text not null,
  wanted_role text not null,
  headcount integer not null default 1 check (headcount between 1 and 30),
  activity_type text not null,
  project_date text not null default '',
  compensation text not null check (compensation in ('paid', 'negotiable', 'exchange', 'volunteer')),
  description text not null,
  highlights jsonb not null default '[]'::jsonb,
  profile_image text not null default '',
  profile_url text not null default '',
  contact text not null,
  edit_token_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists team_posts_search_idx on public.team_posts (status, primary_field, region, wanted_role, created_at desc);
alter table public.team_posts enable row level security;
revoke all on table public.team_posts from anon, authenticated;
grant select, insert, update on table public.team_posts to service_role;
