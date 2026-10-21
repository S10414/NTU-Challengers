/* Revela — Supabase 連線設定
   把下面兩個值換成你自己專案的（Supabase 後台 → Project Settings → API）。

   只能貼「公開」的那把：
     ✔ Project URL
     ✔ anon / publishable key（長得像 eyJ... 或 sb_publishable_...）
     ✘ 絕對不要貼 service_role / secret key —— 這個 repo 是公開的，
       任何人都看得到這個檔案，service_role 等於資料庫的萬用鑰匙。

   anon key 本來就設計成可以放在前端，真正的保護是資料庫的 Row Level Security（RLS），
   一定要先打開，否則任何人都能讀到別人的照片。 */
window.SUPABASE_CONFIG = {
  url:     'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'PASTE-YOUR-ANON-KEY-HERE'
};
