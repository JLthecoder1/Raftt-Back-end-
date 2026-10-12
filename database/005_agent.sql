begin;
-- After 003_backend.sql. Browser roles can read their company's status, never enqueue or claim jobs.
create table if not exists public.agent_jobs (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 kind text not null check(kind in ('application','milestone')),target_id uuid not null,source_id uuid not null,
 status text not null default 'queued' check(status in ('queued','processing','completed','failed','superseded')),
 attempts integer not null default 0 check(attempts between 0 and 3), available_at timestamptz not null default now(),
 lease_token uuid,lease_until timestamptz,report_id uuid references public.ai_reports(id),error_code text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(kind,source_id)
);
alter table public.agent_jobs enable row level security;
revoke all on public.agent_jobs from public,anon,authenticated;
grant select(id,company_id,kind,target_id,source_id,status,attempts,error_code,report_id,created_at,updated_at) on public.agent_jobs to authenticated;
grant all on public.agent_jobs to service_role;
drop policy if exists agent_job_read on public.agent_jobs;
create policy agent_job_read on public.agent_jobs for select to authenticated using(raftt_private.company_access(company_id));
create index if not exists agent_jobs_queue on public.agent_jobs(status,available_at,lease_until);
create or replace function raftt_private.enqueue_agent_job() returns trigger language plpgsql security definer set search_path='' as $$
declare cid uuid; target uuid; k text;
begin
 if tg_table_name='company_applications' then
  cid:=new.company_id; target:=new.id; k:='application';
 else
  select r.company_id into cid from public.milestones m join public.rounds r on r.id=m.round_id where m.id=new.milestone_id;
  target:=new.milestone_id; k:='milestone';
 end if;
 insert into public.agent_jobs(company_id,kind,target_id,source_id) values(cid,k,target,new.id) on conflict(kind,source_id) do nothing;
 return new;
end; $$;
drop trigger if exists application_agent_enqueue on public.company_applications;
create trigger application_agent_enqueue after insert on public.company_applications for each row execute function raftt_private.enqueue_agent_job();
drop trigger if exists evidence_agent_enqueue on public.evidence;
create trigger evidence_agent_enqueue after insert on public.evidence for each row execute function raftt_private.enqueue_agent_job();

create or replace function public.backend_claim_agent_job(p_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.agent_jobs;
begin
 if p_token is null then raise exception 'Lease token required'; end if;
 update public.agent_jobs set status='failed',error_code='lease_exhausted',updated_at=now(),lease_token=null,lease_until=null
 where status='processing' and lease_until<=now() and attempts>=3;
 select * into j from public.agent_jobs where attempts<3 and ((status='queued' and available_at<=now()) or (status='processing' and lease_until<=now())) order by available_at,created_at,id for update skip locked limit 1;
 if j.id is null then return null; end if;
 update public.agent_jobs set status='processing',attempts=attempts+1,lease_token=p_token,lease_until=now()+interval '3 minutes',updated_at=now(),error_code=null where id=j.id returning * into j;
 return to_jsonb(j);
end; $$;
create or replace function public.backend_finish_agent_job(p_job uuid,p_token uuid,p_model text,p_version text,p_input text,p_hash text,p_report jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.agent_jobs; rid uuid; latest uuid;
begin
 select * into j from public.agent_jobs where id=p_job for update;
 if j.id is null or j.status<>'processing' or j.lease_token is distinct from p_token or j.lease_until<=now() then raise exception 'Stale lease'; end if;
 if j.kind='application' then
  -- Serialize with the application's owning company, also used by submission/decision RPCs.
  perform 1 from public.companies where id=j.company_id for update;
  select id into latest from public.company_applications where company_id=j.company_id order by version desc limit 1;
 else
  perform 1 from public.milestones where id=j.target_id for update;
  select id into latest from public.evidence where milestone_id=j.target_id order by created_at desc,id desc limit 1;
 end if;
 if latest is distinct from j.source_id then
  update public.agent_jobs set status='superseded',error_code='superseded',lease_token=null,lease_until=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','superseded');
 end if;
 if p_report is null or p_report->>'recommendation' is null or p_report->>'recommendation' not in ('review_required','changes_requested','insufficient_evidence') or jsonb_typeof(p_report)<>'object' or p_report->>'summary' is null then raise exception 'Invalid report'; end if;
 insert into public.ai_reports(company_id,application_id,milestone_id,model,model_version,input_hash,canonical_input,report)
 values(j.company_id,case when j.kind='application' then j.target_id else null end,case when j.kind='milestone' then j.target_id else null end,p_model,p_version,p_hash,p_input,p_report) returning id into rid;
 update public.agent_jobs set status='completed',report_id=rid,lease_token=null,lease_until=null,error_code=null,updated_at=now() where id=j.id;
 insert into public.notifications(user_id,kind,content) select owner_id,'agent_analysis',jsonb_build_object('companyId',j.company_id,'kind',j.kind,'targetId',j.target_id,'reportId',rid,'recommendation',p_report->>'recommendation') from public.companies where id=j.company_id;
 return jsonb_build_object('status','completed','reportId',rid);
end; $$;
create or replace function public.backend_fail_agent_job(p_job uuid,p_token uuid,p_code text,p_permanent boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.agent_jobs set status=case when p_code='superseded' then 'superseded' when p_permanent or attempts>=3 then 'failed' else 'queued' end,
 error_code=left(p_code,80),available_at=now()+make_interval(secs=>30*attempts*attempts),lease_token=null,lease_until=null,updated_at=now()
 where id=p_job and status='processing' and lease_token=p_token;
end; $$;
revoke all on function public.backend_claim_agent_job(uuid),public.backend_finish_agent_job(uuid,uuid,text,text,text,text,jsonb),public.backend_fail_agent_job(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.backend_claim_agent_job(uuid),public.backend_finish_agent_job(uuid,uuid,text,text,text,text,jsonb),public.backend_fail_agent_job(uuid,uuid,text,boolean) to service_role;
revoke all on function raftt_private.enqueue_agent_job() from public,anon,authenticated;
-- Idempotent backfill: latest pending applications and latest evidence only.
insert into public.agent_jobs(company_id,kind,target_id,source_id)
 select a.company_id,'application',a.id,a.id from public.company_applications a where a.status in ('submitted','reviewing') and not exists(select 1 from public.company_applications n where n.company_id=a.company_id and n.version>a.version)
 on conflict(kind,source_id) do nothing;
insert into public.agent_jobs(company_id,kind,target_id,source_id)
 select r.company_id,'milestone',e.milestone_id,e.id from public.evidence e join public.milestones m on m.id=e.milestone_id join public.rounds r on r.id=m.round_id
 where not exists(select 1 from public.evidence n where n.milestone_id=e.milestone_id and (n.created_at,n.id)>(e.created_at,e.id))
 on conflict(kind,source_id) do nothing;
commit;
