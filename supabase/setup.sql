-- Revela：雲端備份的資料表、照片空間與權限
-- 用法：Supabase 後台 → SQL Editor → New query → 整段貼上 → Run。執行一次就好，重跑也不會壞。
--
-- 權限的原則只有一條：每個人只能讀、寫、刪「自己的」紀錄和照片。
-- 前端用的 publishable / anon key 是公開的，真正擋住別人的是下面的 Row Level Security。

-- 1) 紀錄（照片以外的部分）
create table if not exists public.entries (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  id         text        not null,              -- App 裡的 id（拍下的時間戳）
  ts         bigint      not null,              -- 拍下的時間（毫秒）
  date       text        not null,              -- YYYY-MM-DD（使用者當地日期）
  theme      text        not null,              -- daily / people / place / habit
  line       text        not null default '',   -- 一句話
  late       boolean     not null default false,
  moment     boolean     not null default false,
  has_photo  boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.entries enable row level security;

drop policy if exists "entries: own rows" on public.entries;
create policy "entries: own rows" on public.entries
  for all to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 2) 照片：私人 bucket，路徑一律是 <user_id>/<entry_id>.jpg，單張上限 10MB、只收 JPEG
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos: read own"   on storage.objects;
drop policy if exists "photos: insert own" on storage.objects;
drop policy if exists "photos: update own" on storage.objects;
drop policy if exists "photos: delete own" on storage.objects;

create policy "photos: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "photos: insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "photos: update own" on storage.objects
  for update to authenticated
  using      (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "photos: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 檢查：下面兩行應該都回傳 true
select relrowsecurity as entries_rls_on from pg_class where oid = 'public.entries'::regclass;
select public = false as photos_bucket_private from storage.buckets where id = 'photos';
