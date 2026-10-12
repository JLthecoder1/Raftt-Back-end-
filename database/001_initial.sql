begin;
create extension if not exists pgcrypto;
create schema if not exists raftt_private;
revoke all on schema raftt_private from public;
grant usage on schema raftt_private to authenticated;

create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null default '', language text not null default 'pt' check(language in ('pt','en')),
 settings jsonb not null default '{}'::jsonb check(jsonb_typeof(settings)='object'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.platform_staff (
 user_id uuid primary key references auth.users(id) on delete cascade,
 role text not null check(role in ('reviewer','admin'))
);
create function raftt_private.is_staff() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.platform_staff where user_id=auth.uid());
$$;
create table public.companies (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 name text not null check(length(name) between 1 and 200), description text not null default '',
 sector text, website text, headquarters text, logo_path text, cover_path text,
 publication_status text not null default 'draft' check(publication_status in ('draft','published','archived')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.company_members (
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role in ('admin','collaborator')), primary key(company_id,user_id)
);
create function raftt_private.company_access(cid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select raftt_private.is_staff() or exists(select 1 from public.companies c where c.id=cid and c.owner_id=auth.uid())
 or exists(select 1 from public.company_members m where m.company_id=cid and m.user_id=auth.uid());
$$;
create function raftt_private.company_owner(cid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.companies where id=cid and owner_id=auth.uid());
$$;
create table public.company_applications (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 submitted_by uuid not null references auth.users(id), version integer not null check(version>0),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 status text not null default 'submitted' check(status in ('submitted','reviewing','approved','rejected')),
 created_at timestamptz not null default now(), unique(company_id,version)
);
create table public.rounds (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 instrument text not null check(instrument in ('equity','safe','convertible')),
 network text not null check(network in ('localnet','devnet')),
 program_id text not null, chain_address text, mint text not null, decimals integer not null check(decimals between 0 and 18),
 minimum_units numeric(20,0) not null check(minimum_units>0), cap_units numeric(20,0) not null check(cap_units>=minimum_units and cap_units<=18446744073709551615),
 deadline timestamptz not null, recipient text not null,
 terms jsonb not null default '{}', plan_hash text, terms_version integer not null default 1,
 chain_status text, raised_units numeric(20,0), released_units numeric(20,0), synced_at timestamptz,
 created_at timestamptz not null default now(), unique(network,program_id,chain_address)
);
create table public.milestones (
 id uuid primary key default gen_random_uuid(), round_id uuid not null references public.rounds(id),
 sequence integer not null check(sequence>=0), title text not null, description text not null,
 acceptance_criteria text not null, use_of_funds text not null, amount_units numeric(20,0) not null check(amount_units>0 and amount_units<=18446744073709551615),
 deadline timestamptz, plan_hash text, chain_status text, unique(round_id,sequence)
);
create table public.wallets (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 address text not null unique, verified_at timestamptz not null, created_at timestamptz not null default now()
);
create table public.documents (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 uploaded_by uuid not null references auth.users(id), bucket text not null default 'company-private' check(bucket='company-private'),
 object_path text not null unique, name text not null, kind text not null default 'attachment',
 created_at timestamptz not null default now()
);
create table public.evidence (
 id uuid primary key default gen_random_uuid(), milestone_id uuid not null references public.milestones(id),
 submitted_by uuid not null references auth.users(id), description text not null, evidence_hash text not null,
 document_id uuid references public.documents(id), created_at timestamptz not null default now()
);
create table public.ai_reports (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 application_id uuid references public.company_applications(id), milestone_id uuid references public.milestones(id),
 model text not null, model_version text, input_hash text not null, report jsonb not null,
 created_at timestamptz not null default now()
);
create table public.review_decisions (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 application_id uuid references public.company_applications(id), milestone_id uuid references public.milestones(id),
 reviewer_id uuid not null references auth.users(id), decision text not null check(decision in ('approved','rejected','changes_requested')),
 reason text not null, report_id uuid references public.ai_reports(id), review_hash text,
 created_at timestamptz not null default now()
);
create table public.investments (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 round_id uuid not null references public.rounds(id), wallet_id uuid not null references public.wallets(id),
 position_address text not null, principal_units numeric(20,0) not null check(principal_units>=0),
 synced_at timestamptz not null default now(), unique(round_id,wallet_id)
);
create table public.terms_acceptances (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 round_id uuid not null references public.rounds(id), terms_version integer not null, terms_hash text not null,
 created_at timestamptz not null default now(), unique(user_id,round_id,terms_version)
);
create table public.chain_transactions (
 id uuid primary key default gen_random_uuid(), network text not null check(network in ('localnet','devnet')),
 signature text not null, user_id uuid references auth.users(id), round_id uuid references public.rounds(id),
 operation text not null, amount_units numeric(20,0), status text not null check(status in ('confirmed','failed')),
 chain_time timestamptz, error jsonb, verified_at timestamptz not null default now(), unique(network,signature)
);
create table public.announcements (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 title text not null, body text not null, published_at timestamptz,
 created_at timestamptz not null default now()
);
create table public.notifications (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 kind text not null, content jsonb not null, read_at timestamptz, created_at timestamptz not null default now()
);
create table public.audit_events (
 id bigint generated always as identity primary key, actor_id uuid references auth.users(id),
 entity_table text not null, entity_id text, operation text not null, created_at timestamptz not null default now()
);

create function raftt_private.new_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,name,language) values(new.id,left(coalesce(new.raw_user_meta_data->>'name',''),200),
 case when new.raw_user_meta_data->>'language'='en' then 'en' else 'pt' end);
 return new;
end; $$;
create trigger raftt_new_user after insert on auth.users for each row execute function raftt_private.new_user();
create function raftt_private.audit_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_events(actor_id,entity_table,entity_id,operation)
 values(auth.uid(),tg_table_name,coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id'),tg_op);
 return coalesce(new,old);
end; $$;

-- No role or blockchain-confirmed status can be written by a browser.
do $$ declare t text; begin
 foreach t in array array['profiles','platform_staff','companies','company_members','company_applications','rounds','milestones','wallets','documents','evidence','ai_reports','review_decisions','investments','terms_acceptances','chain_transactions','announcements','notifications','audit_events'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
 foreach t in array array['companies','company_members','company_applications','rounds','milestones','wallets','documents','evidence','ai_reports','review_decisions','chain_transactions'] loop
 execute format('create trigger %I after insert or update or delete on public.%I for each row execute function raftt_private.audit_change()','audit_'||t,t);
 end loop;
end $$;
grant select,update on public.profiles to authenticated;
create policy profile_own on public.profiles for select to authenticated using(id=auth.uid());
create policy profile_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy staff_self on public.platform_staff for select to authenticated using(user_id=auth.uid());
create policy company_read on public.companies for select to authenticated using(publication_status='published' or raftt_private.company_access(id));
grant insert(name,owner_id,description,sector,website,headquarters),update(name,description,sector,website,headquarters,logo_path,cover_path,updated_at) on public.companies to authenticated;
create policy company_insert on public.companies for insert to authenticated with check(owner_id=auth.uid() and publication_status='draft');
create policy company_update on public.companies for update to authenticated using(raftt_private.company_owner(id)) with check(raftt_private.company_owner(id));
create policy member_read on public.company_members for select to authenticated using(raftt_private.company_access(company_id));
create policy application_read on public.company_applications for select to authenticated using(raftt_private.company_access(company_id));
create policy round_read on public.rounds for select to authenticated using(raftt_private.company_access(company_id) or exists(select 1 from public.companies c where c.id=company_id and c.publication_status='published'));
create policy milestone_read on public.milestones for select to authenticated using(exists(select 1 from public.rounds r where r.id=round_id));
create policy wallet_read on public.wallets for select to authenticated using(user_id=auth.uid());
create policy document_read on public.documents for select to authenticated using(raftt_private.company_access(company_id));
grant insert(company_id,uploaded_by,object_path,name,kind) on public.documents to authenticated;
create policy document_insert on public.documents for insert to authenticated with check(raftt_private.company_access(company_id) and uploaded_by=auth.uid() and split_part(object_path,'/',1)=company_id::text);
create policy evidence_read on public.evidence for select to authenticated using(exists(select 1 from public.milestones m join public.rounds r on r.id=m.round_id where m.id=milestone_id and raftt_private.company_access(r.company_id)));
create policy ai_read on public.ai_reports for select to authenticated using(raftt_private.company_access(company_id));
create policy decision_read on public.review_decisions for select to authenticated using(raftt_private.company_access(company_id));
create policy investment_read on public.investments for select to authenticated using(user_id=auth.uid());
create policy acceptance_read on public.terms_acceptances for select to authenticated using(user_id=auth.uid());
grant insert(user_id,round_id,terms_version,terms_hash) on public.terms_acceptances to authenticated;
create policy acceptance_insert on public.terms_acceptances for insert to authenticated with check(user_id=auth.uid() and exists(select 1 from public.rounds r where r.id=round_id and r.terms_version=terms_acceptances.terms_version));
create policy transaction_read on public.chain_transactions for select to authenticated using(user_id=auth.uid() or raftt_private.is_staff());
create policy announcement_read on public.announcements for select to authenticated using(raftt_private.company_access(company_id) or published_at is not null and exists(select 1 from public.companies c where c.id=company_id and c.publication_status='published'));
create policy notification_read on public.notifications for select to authenticated using(user_id=auth.uid());
grant update(read_at) on public.notifications to authenticated;
create policy notification_update on public.notifications for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy audit_read on public.audit_events for select to authenticated using(raftt_private.is_staff());

-- Append-only application versions, checked and committed atomically.
create function public.submit_company_application(cid uuid, details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare appid uuid; nextversion integer;
begin
 if auth.uid() is null or not raftt_private.company_owner(cid) then raise exception 'Company owner required'; end if;
 if jsonb_typeof(details)<>'object' then raise exception 'Invalid application'; end if;
 perform 1 from public.companies where id=cid for update;
 select coalesce(max(version),0)+1 into nextversion from public.company_applications where company_id=cid;
 insert into public.company_applications(company_id,submitted_by,version,payload) values(cid,auth.uid(),nextversion,details) returning id into appid;
 return appid;
end; $$;
revoke all on function public.submit_company_application(uuid,jsonb) from public;
grant execute on function public.submit_company_application(uuid,jsonb) to authenticated;
revoke all on all functions in schema raftt_private from public;
grant execute on function raftt_private.is_staff(),raftt_private.company_access(uuid),raftt_private.company_owner(uuid) to authenticated;

-- Private uploads; the first path segment is a company UUID, validated against membership.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('company-private','company-private',false,20971520,array['application/pdf','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/jpeg','image/png','image/webp']);
create function raftt_private.storage_company(path text) returns uuid language plpgsql immutable set search_path='' as $$
begin return split_part(path,'/',1)::uuid; exception when invalid_text_representation then return null; end; $$;
revoke all on function raftt_private.storage_company(text) from public;
grant execute on function raftt_private.storage_company(text) to authenticated;
create policy raftt_files_read on storage.objects for select to authenticated using(bucket_id='company-private' and raftt_private.company_access(raftt_private.storage_company(name)));
create policy raftt_files_insert on storage.objects for insert to authenticated with check(bucket_id='company-private' and raftt_private.company_access(raftt_private.storage_company(name)));
create policy raftt_files_delete on storage.objects for delete to authenticated using(bucket_id='company-private' and raftt_private.company_owner(raftt_private.storage_company(name)));
create index on public.companies(owner_id);
create index on public.company_members(user_id);
create index on public.company_applications(company_id);
create index on public.rounds(company_id);
create index on public.milestones(round_id);
create index on public.documents(company_id);
create index on public.wallets(user_id);
create index on public.investments(user_id);
create index on public.chain_transactions(user_id);
create index on public.notifications(user_id);
commit;
