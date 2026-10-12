begin;
alter table public.profiles add column avatar_path text;
alter table public.profiles add constraint avatar_own_path check(avatar_path is null or split_part(avatar_path,'/',1)=id::text);
alter table public.companies add constraint logo_company_path check(logo_path is null or split_part(logo_path,'/',1)=id::text);
alter table public.companies add constraint cover_company_path check(cover_path is null or split_part(cover_path,'/',1)=id::text);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('profile-avatars','profile-avatars',false,2097152,array['image/webp']),
 ('company-logos','company-logos',false,2097152,array['image/webp']),
 ('company-covers','company-covers',false,5242880,array['image/webp']);
create policy raftt_avatar_read on storage.objects for select to authenticated using(bucket_id='profile-avatars' and split_part(name,'/',1)=auth.uid()::text);
create policy raftt_avatar_insert on storage.objects for insert to authenticated with check(bucket_id='profile-avatars' and split_part(name,'/',1)=auth.uid()::text);
create policy raftt_avatar_delete on storage.objects for delete to authenticated using(bucket_id='profile-avatars' and split_part(name,'/',1)=auth.uid()::text);
create policy raftt_brand_read on storage.objects for select to authenticated using(bucket_id in ('company-logos','company-covers') and (
 raftt_private.company_access(raftt_private.storage_company(name)) or exists(select 1 from public.companies c where c.id=raftt_private.storage_company(name) and c.publication_status='published')
));
create policy raftt_brand_insert on storage.objects for insert to authenticated with check(bucket_id in ('company-logos','company-covers') and raftt_private.company_owner(raftt_private.storage_company(name)));
create policy raftt_brand_delete on storage.objects for delete to authenticated using(bucket_id in ('company-logos','company-covers') and raftt_private.company_owner(raftt_private.storage_company(name)));
commit;
