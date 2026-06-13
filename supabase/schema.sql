-- Run this once in your Supabase project's SQL editor to set up cloud sync
-- for the StrongLifts 5x5 Tracker.
--
-- It creates a single table that stores each signed-in user's entire app
-- state (history, exercises, weights, plate inventory, etc.) as one JSON
-- blob, with row-level security so users can only read/write their own row.

create table if not exists user_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table user_state enable row level security;

create policy "Users can read their own state"
  on user_state for select
  using (auth.uid() = user_id);

create policy "Users can insert their own state"
  on user_state for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own state"
  on user_state for update
  using (auth.uid() = user_id);
