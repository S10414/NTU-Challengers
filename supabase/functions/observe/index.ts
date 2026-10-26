// 顯影（觀察者）的後端：金鑰放在 Supabase Secrets，App 不碰金鑰。
// 部署：verify_jwt = true（只有登入過的使用者，含匿名帳號，才叫得動）。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-4-6";
const DAILY_LIMIT = 6;            // 每個帳號每天最多幾次（台北時間）
const MAX_BODY = 6_000_000;       // 請求大小上限（bytes）
const MAX_IMAGES = 10, MAX_ENTRIES = 3000, MAX_PAST = 200;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" };
const J = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });

function systemPrompt(habit: string) {
  return `你是「Revela」這個 app 裡的觀察者（功能名稱叫「顯影」）。使用者用這個 app 隨機記錄真實生活的片段（照片＋一句話），分成四個主題：日常、身邊的人、所在之處、習慣（${habit}）。你只做一件事：長期看這些紀錄，只在真的看見一個「跨越時間的模式」時才開口。

你會收到：所有紀錄的日期、星期、時段、主題、一句話（JSON），最近幾張照片（依時間排序，最後一張最新），以及你過去說過的話和使用者的回應。

怎麼決定：
1. 沒有跨時間的模式，或紀錄還太少、太短（少於一週或不到八則），就不要開口：speak=false。沉默是正常的，也是好的。多數時候你應該沉默。
2. 一則紀錄的內容不是模式。模式是「反覆出現」或「明顯改變」：同一個地方、同一個時段、同一種東西、某一天之後變得不一樣。
3. 有把握的行為模式，用「說」（mode=say）：具體指出你看到什麼，然後停下。不解釋意義，不給建議。
4. 涉及詮釋、你沒把握的，用「問」（mode=ask）：講出你注意到的，用一個問題把詮釋權交回給對方。
5. 使用者回過「不是這樣」的觀察，不要再用同一個角度。回過「有這回事」的，可以延續，但不要重複講同一件事。
6. 一次只說一件事，兩句以內。台灣的中文口語，像一個安靜、認識很久的朋友：不熱情、不鼓勵、不下結論。

絕對不做：
- 不評估或猜測心情、狀態、心理健康。不說「你好像很累／低落／迷茫／快樂」。
- 不給方向、建議、鼓勵、稱讚。不說「加油」「很棒」「繼續保持」「可以試試」。
- 不算成就。不講連續幾天、達成幾次。次數只用來描述模式（「這兩週有一半的晚上」），不當成績。
- 不跟任何人比較。
- 不用「數據」「分析」「偵測」「紀錄顯示」這類字。

只輸出 JSON，沒有其他文字、沒有 markdown 圍欄：
{"speak": true 或 false, "mode": "say" 或 "ask", "text": "要說的話；speak=false 時為空字串", "why": "一句話給你自己的備註"}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ error: "method" }, 405);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return J({ error: "not_configured" }, 503);

  // 1) 誰在呼叫
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return J({ error: "auth" }, 401);

  // 2) 內容檢查（避免被當成免費的通用 Claude）
  const raw = await req.text();
  if (raw.length > MAX_BODY) return J({ error: "too_large" }, 413);
  let b: any; try { b = JSON.parse(raw); } catch { return J({ error: "bad_json" }, 400); }
  const entries = Array.isArray(b.entries) ? b.entries.slice(-MAX_ENTRIES) : null;
  if (!entries) return J({ error: "bad_payload" }, 400);
  const habit = String(b.habit || "習慣").slice(0, 8);
  const past = (Array.isArray(b.past_observations) ? b.past_observations : []).slice(-MAX_PAST);
  const images = (Array.isArray(b.images) ? b.images : []).slice(-MAX_IMAGES)
    .filter((s: unknown) => typeof s === "string" && /^[A-Za-z0-9+/=]+$/.test(s as string) && (s as string).length < 900_000);
  const text = JSON.stringify({ today: String(b.today || "").slice(0, 10), habit, entries, past_observations: past });
  if (text.length > 1_500_000) return J({ error: "too_large" }, 413);

  // 3) 每日額度
  const { data: ok, error: qe } = await admin.rpc("observe_take", { p_user: u.user.id, p_limit: DAILY_LIMIT });
  if (qe) return J({ error: "quota_check" }, 500);
  if (!ok) return J({ error: "limit", limit: DAILY_LIMIT }, 429);

  // 4) 呼叫 Anthropic
  const content: unknown[] = images.map((d: string) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } }));
  content.push({ type: "text", text });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, system: systemPrompt(habit), messages: [{ role: "user", content }] }),
  });
  const out = await r.json();
  if (!r.ok) { console.error("anthropic", r.status, JSON.stringify(out).slice(0, 300)); return J({ error: "upstream", status: r.status }, 502); }
  const t = (out.content || []).map((c: any) => c.type === "text" ? c.text : "").join("").replace(/```json|```/g, "").trim();
  try { const p = JSON.parse(t); return J({ speak: !!p.speak, mode: p.mode === "ask" ? "ask" : "say", text: String(p.text || ""), why: String(p.why || "") }); }
  catch { return J({ error: "bad_model_output" }, 502); }
});
