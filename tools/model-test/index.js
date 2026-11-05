// Тест моделей при сборке превью Netlify: те же фото и та же инструкция, что в приложении, разными моделями OpenRouter.
// Работает только в deploy-preview, ключ берётся из OPENROUTER_API_KEY и никуда не выводится. Итог — в сводке деплоя.
import { readFileSync } from "node:fs";
import { buildSystem } from "../../netlify/shared/system-prompt.js";
import { OWNER_HAND } from "../../netlify/shared/hand.js";

const MODELS = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5.5@high",
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-haiku-5.5@medium",
  "google/gemini-3.8-flash",
  "google/gemini-3.5-flash-lite"
];
const TESTS = [
  { id: "творожок", photos: ["tvorozhok"], truth: "этикетка: Ирменский 0,5%, около 164 ккал за стаканчик" },
  { id: "шоколад", photos: ["choco1", "choco2"], truth: "один кусочек молочного шоколада, 2 ракурса" },
  { id: "стол", photos: ["stol"], truth: "рыба, картошка, помидоры, соус; ладонь сбоку" },
  { id: "конфеты", photos: ["konfety"], truth: "тарелка: батончики и драже, ладонь рядом" }
];
const ASK = "Посчитай еду на этих фото. Если видна этикетка с пищевой ценностью — бери цифры с неё. Если на фото бутылка, банка или упаковка — считай весь её объём по этикетке, а не 100 мл или 100 г. Одна и та же упаковка на нескольких фото (лицом, боком, этикеткой) — это одна штука.";
const SEARCH_TOOL = { type: "openrouter:web_search", parameters: { engine: "exa", max_results: 5, max_total_results: 12 } };

async function call(key, system, parts, spec) {
  const [model, effort] = spec.split("@");
  const t0 = Date.now();
  const body = withSearch => JSON.stringify({
    model, messages: [{ role: "system", content: system }, { role: "user", content: parts }],
    ...(withSearch ? { tools: [SEARCH_TOOL], max_tool_calls: 4 } : {}),
    ...(effort ? { reasoning: { effort, exclude: true } } : {}),
    max_tokens: effort ? 16000 : 4096, temperature: effort ? 1 : 0.3, usage: { include: true }
  });
  const send = s => fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key, "X-Title": "Hammer KBZHU model test" }, body: body(s) });
  try {
    let r = await send(true);
    let searched = true;
    if (r.status === 400) { r = await send(false); searched = false; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return { spec, error: String((d.error && d.error.message) || r.status).slice(0, 160) };
    let raw = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (Array.isArray(raw)) raw = raw.map(p => p.text || "").join("");
    raw = String(raw || "");
    const m = raw.match(/#ИТОГ\s+ккал=(\d+)\s+б=(\d+)\s+ж=(\d+)\s+у=(\d+)/);
    const u = d.usage || {};
    return { spec, kcal: m ? +m[1] : null, bju: m ? [+m[2], +m[3], +m[4]] : null, cost: u.cost, in: u.prompt_tokens, out: u.completion_tokens,
      think: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
      sec: Math.round((Date.now() - t0) / 100) / 10, searched,
      conf: (raw.match(/Уверенность:\s*([а-яё]+)/i) || [])[1] || "", text: raw.replace(/\n?#(ИТОГ|ПРОДУКТ)[^\n]*/g, "").trim() };
  } catch (e) { return { spec, error: String(e.message).slice(0, 160) }; }
}

export const onPreBuild = async ({ utils }) => {
  if (process.env.CONTEXT !== "deploy-preview") return;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { utils.status.show({ title: "Тест моделей", summary: "Нет OPENROUTER_API_KEY в сборке" }); return; }
  const system = buildSystem({ name: "Михаил", owner: true, hand: OWNER_HAND, search: true, foods: [] });
  const dir = new URL("./photos/", import.meta.url);
  const all = await Promise.all(TESTS.map(async t => {
    const parts = [];
    t.photos.forEach((p, i) => {
      parts.push({ type: "text", text: "Фото " + (i + 1) });
      parts.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + readFileSync(new URL(p + ".jpg", dir)).toString("base64") } });
    });
    parts.push({ type: "text", text: ASK });
    return { ...t, results: await Promise.all(MODELS.map(s => call(key, system, parts, s))) };
  }));
  const short = s => s.replace("anthropic/claude-", "").replace("google/gemini-", "gemini-");
  const line = r => r.error ? short(r.spec) + " ОШИБКА " + r.error.slice(0, 60)
    : short(r.spec) + " " + r.kcal + "ккал $" + Number(r.cost || 0).toFixed(4) + " " + r.sec + "с";
  const summary = all.map(t => t.id + ": " + t.results.map(line).join("; ")).join("\n");
  const text = all.map(t => "## " + t.id + " (" + t.truth + ")\n" + t.results.map(r => r.error ? "### " + short(r.spec) + ": " + r.error :
    "### " + short(r.spec) + ": " + r.kcal + " ккал, Б/Ж/У " + r.bju + ", $" + r.cost + ", " + r.sec + " с, in " + r.in + " out " + r.out +
    " think " + r.think + ", поиск " + r.searched + ", уверенность " + r.conf + "\n" + r.text.slice(0, 700)).join("\n")).join("\n\n");
  console.log(summary);
  utils.status.show({ title: "Тест моделей", summary: summary.slice(0, 4000), text: text.slice(0, 60000) });
  // Сводка деплоя не видна снаружи, поэтому итог отдаём в сообщении об ошибке сборки (превью не нужно).
  const items = r => (r.text || "").split("\n").filter(l => /^\d+\./.test(l.trim())).map(l => l.trim().slice(0, 70)).join(" / ");
  const compact = all.map(t => "[" + t.id + "] " + t.results.map(r => r.error ? short(r.spec) + ": ERR " + r.error.slice(0, 80)
    : short(r.spec) + ": " + r.kcal + "к $" + Number(r.cost || 0).toFixed(4) + " " + r.sec + "с out" + r.out + " th" + r.think +
      (r.searched ? "" : " nosearch") + " ув:" + r.conf + " | " + items(r)).join(" || ")).join(" #### ");
  utils.build.failBuild("MODELTEST " + compact.slice(0, 9000));
};
