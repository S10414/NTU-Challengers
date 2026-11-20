// 帳號相關：兌換邀請碼（分組）、刪除帳號（含雲端所有資料）。verify_jwt = true。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" };
const J = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return J({ error: "auth" }, 401);
  const uid = u.user.id;
  let b: any; try { b = await req.json(); } catch { return J({ error: "bad_json" }, 400); }

  if (b.action === "redeem") {
    const code = String(b.code || "").trim().toUpperCase().slice(0, 40);
    const { data: had } = await admin.from("participants").select("ai_from,code").eq("user_id", uid).maybeSingle();
    if (had) return J({ ok: true, ai_from: had.ai_from, already: true });
    const { data: inv } = await admin.from("invites").select("*").eq("code", code).maybeSingle();
    if (!inv || inv.used >= inv.max_uses) return J({ error: "bad_code" }, 400);
    // 先佔名額（樂觀鎖：used 沒被別人改過才成功）
    const { data: upd } = await admin.from("invites").update({ used: inv.used + 1 }).eq("code", code).eq("used", inv.used).select("code");
    if (!upd || !upd.length) return J({ error: "busy" }, 409);
    const ai_from = inv.ai_offset_days == null ? null : addDays(taipeiToday(), inv.ai_offset_days);
    const { error: pe } = await admin.from("participants").insert({ user_id: uid, code, ai_from });
    if (pe) { await admin.from("invites").update({ used: inv.used }).eq("code", code); return J({ error: "save_failed" }, 500); }
    return J({ ok: true, ai_from });
  }

  if (b.action === "delete") {
    // 1) 照片
    const store = admin.storage.from("photos");
    for (let i = 0; i < 50; i++) {
      const { data, error } = await store.list(uid, { limit: 1000 });
      if (error) return J({ error: "storage_list" }, 500);
      if (!data || !data.length) break;
      const { error: re } = await store.remove(data.map((o) => `${uid}/${o.name}`));
      if (re) return J({ error: "storage_remove" }, 500);
    }
    // 2) 資料表
    for (const t of ["entries", "observations", "consents", "participants", "observe_usage", "intake", "peer_requests", "peer_notes"]) {
      const { error } = await admin.from(t).delete().eq("user_id", uid);
      if (error) return J({ error: "delete_" + t }, 500);
    }
    // 3) 帳號本身
    const { error: de } = await admin.auth.admin.deleteUser(uid);
    if (de) return J({ error: "delete_user" }, 500);
    return J({ ok: true });
  }
  return J({ error: "unknown_action" }, 400);
});
