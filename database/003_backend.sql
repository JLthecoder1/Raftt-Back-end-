begin;
-- Apply after 001_initial.sql and 002_images.sql. No existing data is removed.
create table if not exists public.backend_wallet_challenges (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 address text not null, message text not null, expires_at timestamptz not null,
 consumed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.backend_round_drafts (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 application_id uuid not null references public.company_applications(id), user_id uuid not null references auth.users(id),
 wallet_id uuid not null references public.wallets(id), params jsonb not null, plan_document text not null,
 instruction_data text, expires_at timestamptz not null, registered_round_id uuid references public.rounds(id),
 created_at timestamptz not null default now()
);
alter table public.rounds add column if not exists chain_slot bigint not null default 0;
alter table public.rounds add column if not exists plan_document text;
alter table public.milestones add column if not exists plan_document text;
alter table public.milestones add column if not exists chain_slot bigint not null default 0;
alter table public.evidence add column if not exists canonical_document text;
alter table public.ai_reports add column if not exists canonical_input text;
alter table public.review_decisions add column if not exists canonical_document text;
alter table public.backend_wallet_challenges enable row level security;
alter table public.backend_round_drafts enable row level security;
revoke all on public.backend_wallet_challenges,public.backend_round_drafts from public,anon,authenticated;
grant all on public.backend_wallet_challenges,public.backend_round_drafts to service_role;
create index if not exists backend_wallet_challenges_expiry on public.backend_wallet_challenges(expires_at);
create index if not exists backend_round_drafts_user on public.backend_round_drafts(user_id);

create or replace function public.backend_verify_wallet(p_challenge uuid,p_user uuid,p_wallet text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.backend_wallet_challenges; w public.wallets;
begin
 select * into c from public.backend_wallet_challenges where id=p_challenge and user_id=p_user and address=p_wallet for update;
 if c.id is null or c.consumed_at is not null or c.expires_at<=now() then raise exception 'Challenge expired or already used'; end if;
 insert into public.wallets(user_id,address,verified_at) values(p_user,p_wallet,now())
 on conflict(address) do update set verified_at=excluded.verified_at where public.wallets.user_id=p_user returning * into w;
 if w.id is null then raise exception 'Wallet belongs to another account'; end if;
 update public.backend_wallet_challenges set consumed_at=now() where id=c.id;
 return to_jsonb(w);
end; $$;

create or replace function public.backend_decide_application(p_application uuid,p_reviewer uuid,p_decision text,p_reason text,p_report uuid,p_hash text,p_document text)
returns uuid language plpgsql security definer set search_path='' as $$
declare a public.company_applications; did uuid;
begin
 if not exists(select 1 from public.platform_staff where user_id=p_reviewer and role in ('reviewer','admin')) then raise exception 'Reviewer required'; end if;
 if p_decision not in ('approved','rejected','changes_requested') then raise exception 'Invalid decision'; end if;
 select * into a from public.company_applications where id=p_application for update;
 if a.id is null then raise exception 'Application missing'; end if;
 perform 1 from public.companies where id=a.company_id for update;
 if exists(select 1 from public.company_applications where company_id=a.company_id and version>a.version) then raise exception 'Application superseded'; end if;
 if a.status not in ('submitted','reviewing') then raise exception 'Application already decided'; end if;
 if p_report is not null and not exists(select 1 from public.ai_reports where id=p_report and application_id=a.id and company_id=a.company_id) then raise exception 'Report mismatch'; end if;
 insert into public.review_decisions(company_id,application_id,reviewer_id,decision,reason,report_id,review_hash,canonical_document)
 values(a.company_id,a.id,p_reviewer,p_decision,p_reason,p_report,p_hash,p_document) returning id into did;
 if p_decision='approved' then
 update public.companies set name=coalesce(nullif(left(a.payload->>'companyName',200),''),name), description=coalesce(a.payload->>'businessDescription',description), sector=coalesce(a.payload->>'sector',sector), website=coalesce(a.payload->>'website',website), headquarters=coalesce(a.payload->>'headquarters',headquarters), updated_at=now() where id=a.company_id;
 end if;
 insert into public.notifications(user_id,kind,content) select owner_id,'application_decision',jsonb_build_object('applicationId',a.id,'decision',p_decision,'reason',p_reason) from public.companies where id=a.company_id;
 update public.company_applications set status=case when p_decision='changes_requested' then 'reviewing' else p_decision end where id=a.id;
 return did;
end; $$;

create or replace function public.backend_register_round(p_draft uuid,p_user uuid,p_signature text,p_snapshot jsonb,p_slot bigint,p_time timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare d public.backend_round_drafts; rid uuid; a public.company_applications;
begin
 select * into d from public.backend_round_drafts where id=p_draft and user_id=p_user for update;
 if d.id is null then raise exception 'Draft missing'; end if;
 if d.registered_round_id is not null then return d.registered_round_id; end if;
 if d.expires_at<=now() then raise exception 'Draft expired'; end if;
 select * into a from public.company_applications where id=d.application_id;
 perform 1 from public.companies where id=d.company_id and owner_id=p_user for update;
 if not found or a.status<>'approved' or exists(select 1 from public.company_applications where company_id=d.company_id and version>a.version) then raise exception 'Approved current application required'; end if;
 if p_snapshot->>'creator' is distinct from d.params->>'creator' or p_snapshot->>'mint' is distinct from d.params->>'mint'
 or p_snapshot->>'plan_hash' is distinct from d.params->>'plan_hash' or p_snapshot->>'minimum' is distinct from d.params->>'minimum'
 or p_snapshot->>'cap' is distinct from d.params->>'cap' or p_snapshot->>'round_id' is distinct from d.params->>'round_id'
 or p_snapshot->>'deadline' is distinct from d.params->>'deadline' or p_snapshot->>'recipient' is distinct from d.params->>'recipient' then raise exception 'Snapshot mismatch'; end if;
 insert into public.rounds(company_id,instrument,network,program_id,chain_address,mint,decimals,minimum_units,cap_units,deadline,recipient,terms,plan_hash,plan_document,chain_status,raised_units,released_units,synced_at,chain_slot)
 values(d.company_id,d.params->>'instrument',d.params->>'network',d.params->>'program_id',d.params->>'round_address',p_snapshot->>'mint',(d.params->>'decimals')::integer,(p_snapshot->>'minimum')::numeric,(p_snapshot->>'cap')::numeric,to_timestamp((p_snapshot->>'deadline')::double precision),p_snapshot->>'recipient',d.params->'terms',p_snapshot->>'plan_hash',d.plan_document,p_snapshot->>'chain_status',(p_snapshot->>'raised')::numeric,(p_snapshot->>'released')::numeric,now(),p_slot) returning id into rid;
 insert into public.chain_transactions(network,signature,user_id,round_id,operation,status,chain_time)
 values(d.params->>'network',p_signature,p_user,rid,'create_round','confirmed',p_time);
 update public.backend_round_drafts set registered_round_id=rid where id=d.id;
 return rid;
end; $$;
revoke all on function public.backend_verify_wallet(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.backend_decide_application(uuid,uuid,text,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.backend_register_round(uuid,uuid,text,jsonb,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.backend_verify_wallet(uuid,uuid,text) to service_role;
grant execute on function public.backend_decide_application(uuid,uuid,text,text,uuid,text,text) to service_role;
grant execute on function public.backend_register_round(uuid,uuid,text,jsonb,bigint,timestamptz) to service_role;
alter table public.investments add column if not exists chain_slot bigint not null default 0;
create or replace function public.backend_sync_position(p_user uuid,p_round uuid,p_wallet uuid,p_position text,p_amount text,p_slot bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.investments;
begin
 if not exists(select 1 from public.wallets where id=p_wallet and user_id=p_user) then raise exception 'Wallet mismatch'; end if;
 if p_amount!~'^[0-9]+$' or p_amount::numeric>18446744073709551615 then raise exception 'Amount invalid'; end if;
 insert into public.investments(user_id,round_id,wallet_id,position_address,principal_units,chain_slot,synced_at)
 values(p_user,p_round,p_wallet,p_position,p_amount::numeric,p_slot,now())
 on conflict(round_id,wallet_id) do update set principal_units=excluded.principal_units,chain_slot=excluded.chain_slot,synced_at=excluded.synced_at
 where public.investments.chain_slot<=excluded.chain_slot returning * into item;
 if item.id is null then select * into item from public.investments where round_id=p_round and wallet_id=p_wallet; end if;
 return to_jsonb(item);
end; $$;
create or replace function public.backend_publish_company(p_company uuid,p_reviewer uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.companies; app public.company_applications;
begin
 if not exists(select 1 from public.platform_staff where user_id=p_reviewer and role in ('reviewer','admin')) then raise exception 'Reviewer required'; end if;
 select * into c from public.companies where id=p_company for update;
 if c.id is null then raise exception 'Company missing'; end if;
 select * into app from public.company_applications where company_id=c.id order by version desc limit 1;
 if app.id is null or app.status<>'approved' then raise exception 'Current approval required'; end if;
 update public.companies set publication_status='published',updated_at=now() where id=c.id returning * into c;
 return to_jsonb(c);
end; $$;
revoke all on function public.backend_sync_position(uuid,uuid,uuid,text,text,bigint) from public,anon,authenticated;
revoke all on function public.backend_publish_company(uuid,uuid) from public,anon,authenticated;
grant execute on function public.backend_sync_position(uuid,uuid,uuid,text,text,bigint) to service_role;
grant execute on function public.backend_publish_company(uuid,uuid) to service_role;
commit;
