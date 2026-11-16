-- ===== 種子測試：邀請碼、分組、同意紀錄、觀察紀錄、研究用匿名檢視（v13） =====

-- 邀請碼：ai_offset_days = 兌換後第幾天開始有顯影；null = 只記錄（不會有顯影）
create table if not exists public.invites (
  code text primary key,
  label text not null default '',
  ai_offset_days int,
  max_uses int not null default 1,
  used int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.invites enable row level security;   -- 沒有 policy：只有後端讀得到，邀請碼不會被列出

-- 參與者：一個帳號一筆，組別由伺服器決定
create table if not exists public.participants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null references public.invites(code),
  ai_from date,                                   -- null = 只記錄組
  joined_at timestamptz not null default now()
);
alter table public.participants enable row level security;
drop policy if exists "participants: read own" on public.participants;
create policy "participants: read own" on public.participants for select to authenticated
  using (user_id = (select auth.uid()));

-- 同意紀錄：只增不改，最新一筆為準
create table if not exists public.consents (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  version text not null,
  backup boolean not null,
  ai boolean not null,
  research boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists consents_user_idx on public.consents(user_id, created_at desc);
alter table public.consents enable row level security;
drop policy if exists "consents: read own" on public.consents;
create policy "consents: read own" on public.consents for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "consents: insert own" on public.consents;
create policy "consents: insert own" on public.consents for insert to authenticated with check (user_id = (select auth.uid()));

-- 觀察紀錄：每次呼叫一筆（含沉默），只有同意研究的人才寫入；由後端寫
create table if not exists public.observations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  spoke boolean not null,
  mode text,
  text text not null default '',
  why text not null default '',
  n_entries int not null default 0,
  span_days int not null default 0,
  model text not null default '',
  reaction text check (reaction in ('interesting','meh','wrong')),
  reply text not null default '',
  reacted_at timestamptz
);
create index if not exists observations_user_idx on public.observations(user_id, created_at desc);
alter table public.observations enable row level security;
drop policy if exists "observations: read own" on public.observations;
create policy "observations: read own" on public.observations for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "observations: feedback own" on public.observations;
create policy "observations: feedback own" on public.observations for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke insert, update, delete on public.observations from anon, authenticated;
grant update (reaction, reply, reacted_at) on public.observations to authenticated;   -- 使用者只能改回饋欄位

-- 研究用檢視：放在不對外開放的 research schema，只有 SQL Editor（postgres）看得到
-- 代號 = 帳號 id 加鹽雜湊；不含 email、照片、照片路徑
create schema if not exists research;
revoke all on schema research from public, anon, authenticated;

create or replace view research.participants as
select substr(md5('revela-salt-115-1:' || p.user_id::text), 1, 10) as pid,
       p.code as invite, i.label as grp, p.ai_from, p.joined_at
from public.participants p join public.invites i on i.code = p.code
where (select c.research from public.consents c where c.user_id = p.user_id order by c.created_at desc limit 1);

create or replace view research.observations as
select substr(md5('revela-salt-115-1:' || o.user_id::text), 1, 10) as pid,
       o.created_at, o.spoke, o.mode, o.text, o.why, o.n_entries, o.span_days, o.model,
       o.reaction, o.reply, o.reacted_at
from public.observations o
where (select c.research from public.consents c where c.user_id = o.user_id order by c.created_at desc limit 1);

-- 記錄行為（不含文字內容）：用來算持續記錄率；需要該使用者有開備份
create or replace view research.entry_activity as
select substr(md5('revela-salt-115-1:' || e.user_id::text), 1, 10) as pid,
       e.date, to_timestamp(e.ts/1000.0) as captured_at, e.theme, e.moment, e.late, e.has_photo,
       length(coalesce(e.line,'')) as line_len
from public.entries e
where (select c.research from public.consents c where c.user_id = e.user_id order by c.created_at desc limit 1);

revoke all on all tables in schema research from public, anon, authenticated;

insert into public.invites(code,label,ai_offset_days,max_uses) values ('REVELA-TEAM','team',0,5) on conflict do nothing;

-- v14：事後補上的紀錄（從相簿選、或補過去某一天）
alter table public.entries add column if not exists backfill boolean not null default false;
create or replace view research.entry_activity as
select substr(md5('revela-salt-115-1:' || e.user_id::text), 1, 10) as pid,
       e.date, to_timestamp(e.ts/1000.0) as captured_at, e.theme, e.moment, e.late, e.has_photo,
       length(coalesce(e.line,'')) as line_len, e.backfill
from public.entries e
where (select c.research from public.consents c where c.user_id = e.user_id order by c.created_at desc limit 1);
revoke all on all tables in schema research from public, anon, authenticated;
