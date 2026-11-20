// 一句話交換：匿名、單向、非即時。verify_jwt = true。
// submit：記下「今天想收到什麼」＋（選填）留一句給別人。留言先交給 Claude 判斷語氣、標記個資／嘲諷／不適合轉送的內容；沒問題才進留言池。
// inbox：隔天起替還在等的請求配一則留言（同情境＋需要的回應優先、不重複投遞），回傳收到的話與統計。
// widen：同情境沒有留言時，使用者同意收「不同處境的一句」。react：有被陪伴到／不太適合／檢舉。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "claude-haiku-4-5";
const CTX = ["課業", "工作", "人際關係", "家人", "身體與運動", "生活瑣事", "說不上來"];
const NEEDS = ["understand", "encourage"];
const MAX_DELIVERIES = 3;        // 一則留言最多送給幾個人
const EXPIRE_DAYS = 3;           // 等幾天還配不到就結束
const STATS_MIN_TOTAL = 30, STATS_MIN_SAME = 5;   // 人太少或情境太細就不顯示統計
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" };
const J = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const taipeiNow = () => new Date(Date.now() + 8 * 3600e3);
const taipeiToday = () => taipeiNow().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
function weekStartTaipei() { const t = taipeiNow(); const wd = (t.getUTCDay() + 6) % 7; return addDays(t.toISOString().slice(0, 10), -wd); }

const MOD_PROMPT = `你在審一則要匿名轉送給陌生人的短留言。寫的人知道這句話會被送給「也選了同一種煩惱」的另一個人。
判斷兩件事，只輸出 JSON：
1. tone：這句話偏向哪一種回應？
   - "understand"：理解、陪伴、說出對方的感受（例：「最難受的可能是，你知道自己真的有認真」）
   - "encourage"：打氣、相信對方（例：「你已經撐過很多次了，這次也會」）
   - "advice"：給方法、建議（例：「下次試試看提早兩週念」）
2. flags：有下列問題就列出來，沒有就給空陣列。
   - "pii"：姓名、電話、帳號、學號、地址、學校系級等可以認出人的資訊，或要對方加好友、私訊、聯絡
   - "mocking"：嘲諷、說教、貶低、不耐煩
   - "harmful"：鼓勵傷害自己或別人、危險行為、仇恨或騷擾
   - "crisis"：寫的人自己透露想傷害自己或很危險的狀況（這句不適合轉送，需要人看）
   - "offtopic"：廣告、無意義的字、跟安慰別人無關
{"tone":"understand|encourage|advice","flags":[]}`;

async function moderate(text: string, ctx: string): Promise<{ tone: string; flags: string[]; ok: boolean }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { tone: "encourage", flags: ["unchecked"], ok: false };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 120, system: MOD_PROMPT,
        messages: [{ role: "user", content: `情境：${ctx}\n留言：${text}` }] }),
    });
    const out = await r.json();
    if (!r.ok) { console.error("anthropic", r.status, JSON.stringify(out).slice(0, 200)); return { tone: "encourage", flags: ["unchecked"], ok: false }; }
    const raw = String(out?.content?.[0]?.text || "").replace(/```json|```/g, "").trim();
    const m = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const tone = ["understand", "encourage", "advice"].includes(m.tone) ? m.tone : "encourage";
    const flags = Array.isArray(m.flags) ? m.flags.map(String).slice(0, 5) : ["unparsed"];
    return { tone, flags, ok: flags.length === 0 };
  } catch (e) {
    console.error("moderate", e);
    return { tone: "encourage", flags: ["unchecked"], ok: false };   // 判斷不了就先擋下，等人看
  }
}

// 同情境優先，再看語氣合不合需要，再挑被送出最少次的
const TONE_RANK: Record<string, string[]> = { understand: ["understand", "encourage", "advice"], encourage: ["encourage", "understand", "advice"] };
async function match(admin: any, uid: string, req: any) {
  const { data: got } = await admin.from("peer_deliveries").select("note_id").eq("recipient", uid);
  const seen = new Set((got || []).map((x: any) => x.note_id));
  let q = admin.from("peer_notes").select("id,ctx,tone,deliveries").eq("status", "ok").neq("user_id", uid)
    .lt("deliveries", MAX_DELIVERIES).gte("created_at", new Date(Date.now() - 45 * 864e5).toISOString()).limit(300);
  if (!req.allow_other) q = q.eq("ctx", req.ctx);
  const { data: pool } = await q;
  const cand = (pool || []).filter((n: any) => !seen.has(n.id));
  if (!cand.length) return null;
  const rank = TONE_RANK[req.need] || TONE_RANK.encourage;
  cand.sort((a: any, b: any) =>
    ((a.ctx === req.ctx ? 0 : 1) - (b.ctx === req.ctx ? 0 : 1)) ||
    (rank.indexOf(a.tone) - rank.indexOf(b.tone)) ||
    (a.deliveries - b.deliveries) || (Math.random() - 0.5));
  for (const n of cand.slice(0, 5)) {
    const { data: upd } = await admin.from("peer_notes").update({ deliveries: n.deliveries + 1 }).eq("id", n.id).eq("deliveries", n.deliveries).select("id");
    if (!upd || !upd.length) continue;   // 被別人同時拿走了，換下一則
    const { error } = await admin.from("peer_deliveries").insert({ request_id: req.id, note_id: n.id, recipient: uid, same_ctx: n.ctx === req.ctx });
    if (error) { await admin.from("peer_notes").update({ deliveries: n.deliveries }).eq("id", n.id); continue; }
    await admin.from("peer_requests").update({ status: "delivered" }).eq("id", req.id);
    return n;
  }
  return null;
}

async function stats(admin: any, ctx: string) {
  const ws = weekStartTaipei();
  const [{ data: r }, { data: n }] = await Promise.all([
    admin.from("peer_requests").select("user_id,ctx").gte("day", ws),
    admin.from("peer_notes").select("user_id,ctx").gte("day", ws),
  ]);
  const all = new Set<string>(), same = new Set<string>();
  for (const x of [...(r || []), ...(n || [])]) { all.add(x.user_id); if (x.ctx === ctx) same.add(x.user_id); }
  if (all.size < STATS_MIN_TOTAL || same.size < STATS_MIN_SAME) return null;
  return { total: all.size, same: same.size, ctx };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return J({ error: "auth" }, 401);
  const uid = u.user.id, today = taipeiToday();
  let b: any; try { b = await req.json(); } catch { return J({ error: "bad_json" }, 400); }

  if (b.action === "submit") {
    const ctx = String(b.ctx || ""), need = b.need ? String(b.need) : null;
    const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!CTX.includes(ctx)) return J({ error: "bad_ctx" }, 400);
    if (need && !NEEDS.includes(need)) return J({ error: "bad_need" }, 400);
    const out: any = { ok: true };
    if (need) {
      const { error } = await admin.from("peer_requests").insert({ user_id: uid, day: today, need, ctx });
      out.request = error ? (error.code === "23505" ? "already" : "failed") : "waiting";
    }
    if (text.length >= 2) {
      const { data: had } = await admin.from("peer_notes").select("id").eq("user_id", uid).eq("day", today).maybeSingle();
      if (had) out.note = "already";
      else {
        const m = await moderate(text, ctx);
        const { error } = await admin.from("peer_notes").insert({ user_id: uid, day: today, ctx, text, tone: m.tone, status: m.ok ? "ok" : "held", flags: m.flags.join(",") });
        out.note = error ? "failed" : (m.ok ? "ok" : "held");
        if (m.flags.includes("crisis")) out.care = true;   // App 會顯示求助資訊
      }
    }
    return J(out);
  }

  if (b.action === "widen") {
    const id = Number(b.id);
    const { data: r } = await admin.from("peer_requests").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
    if (!r) return J({ error: "not_found" }, 404);
    await admin.from("peer_requests").update({ allow_other: true, status: "waiting" }).eq("id", id);
    b.action = "inbox";
  }

  if (b.action === "react") {
    const id = Number(b.id), reaction = String(b.reaction || "");
    if (!["felt", "notfit", "report"].includes(reaction)) return J({ error: "bad_reaction" }, 400);
    const { data: d } = await admin.from("peer_deliveries").update({ reaction, reacted_at: new Date().toISOString() }).eq("id", id).eq("recipient", uid).select("note_id");
    if (!d || !d.length) return J({ error: "not_found" }, 404);
    if (reaction === "report") await admin.from("peer_notes").update({ status: "reported" }).eq("id", d[0].note_id).eq("status", "ok");
    return J({ ok: true });
  }

  if (b.action === "inbox") {
    // 1) 替隔天以後還在等的請求配對；等太久就結束
    const { data: waiting } = await admin.from("peer_requests").select("*").eq("user_id", uid).in("status", ["waiting", "nomatch"]).order("day");
    for (const r of waiting || []) {
      if (r.day >= today && !r.allow_other) continue;               // 隔天才送（放寬處境後就不用再等）
      const got = await match(admin, uid, r);
      if (got) continue;
      if (addDays(r.day, EXPIRE_DAYS) <= today) await admin.from("peer_requests").update({ status: "expired" }).eq("id", r.id);
      else if (!r.allow_other && r.status !== "nomatch") await admin.from("peer_requests").update({ status: "nomatch" }).eq("id", r.id);
    }
    // 2) 收到的話（最近 30 天）
    const { data: dl } = await admin.from("peer_deliveries")
      .select("id,same_ctx,reaction,created_at,request_id,peer_notes(text,ctx,status),peer_requests(ctx,need,day)")
      .eq("recipient", uid).gte("created_at", new Date(Date.now() - 30 * 864e5).toISOString()).order("created_at", { ascending: false }).limit(20);
    const items = (dl || []).filter((x: any) => x.peer_notes?.status !== "removed").map((x: any) => ({ id: x.id, text: x.peer_notes?.text || "", ctx: x.peer_notes?.ctx || "", myCtx: x.peer_requests?.ctx || "",
      need: x.peer_requests?.need || "", same: x.same_ctx, reaction: x.reaction, at: x.created_at }));
    // 3) 最近一筆請求的狀態
    const { data: last } = await admin.from("peer_requests").select("id,day,need,ctx,status,allow_other").eq("user_id", uid).order("day", { ascending: false }).limit(1).maybeSingle();
    const st = last ? await stats(admin, last.ctx) : null;
    return J({ ok: true, today, items, request: last || null, stats: st });
  }
  return J({ error: "unknown_action" }, 400);
});
