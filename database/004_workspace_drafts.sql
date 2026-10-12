-- Additional migration after 001, 002 and backend 003. No existing records are removed.
begin;
create table if not exists public.workspace_drafts (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_key text not null check (length(workspace_key) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) in ('object','array') and length(payload::text) <= 200000),
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_key)
);
alter table public.workspace_drafts enable row level security;
revoke all on public.workspace_drafts from anon, authenticated;
grant select, insert, update, delete on public.workspace_drafts to authenticated;
grant all on public.workspace_drafts to service_role;
drop policy if exists workspace_draft_own on public.workspace_drafts;
create policy workspace_draft_own on public.workspace_drafts
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
comment on table public.workspace_drafts is 'Private editable drafts. Never a source of financial confirmation, reviewer role or on-chain authorization.';
commit;
