// Сервер страницы foto/ (Netlify Edge Function: ожидание ответа Claude не тратит лимит времени).
// хранит ключ Claude API, пускает по личным ссылкам,
// считает еду по фото и хранит историю каждого человека.
import { getStore } from "@netlify/blobs";
import { SYSTEM } from "../shared/system-prompt.js";

const MODEL = "claude-sonnet-5-5";
const DAILY_LIMIT = 40;      // расчётов на человека в день
const MAX_PHOTOS = 20;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const newToken = () => [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");

async function handle(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, "");
  const store = getStore({ name: "foto", consistency: "strong" });
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const token = body.token || url.searchParams.get("t") || "";
  const users = (await store.get("users", { type: "json" })) || {};

  // Первый запуск: владелец отдаёт ключ API, получает свою личную ссылку.
  if (route === "status") {
    return json({ configured: !!(await store.get("apiKey")), user: users[token] ? { name: users[token].name, owner: !!users[token].owner } : null });
  }
  if (route === "setup") {
    if (await store.get("apiKey")) return json({ error: "Сервер уже настроен" }, 409);
    if (!/^sk-ant-/.test(body.key || "")) return json({ error: "Это не ключ Claude API" }, 400);
    const t = newToken();
    users[t] = { name: "Михаил", owner: true, created: Date.now() };
    await store.set("apiKey", body.key.trim());
    await store.setJSON("users", users);
    return json({ token: t });
  }

  const user = users[token];
  if (!user) return json({ error: "Нет доступа. Попроси личную ссылку у тренера." }, 401);

  if (route === "invite") {
    if (!user.owner) return json({ error: "Только тренер может приглашать" }, 403);
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return json({ error: "Нужно имя" }, 400);
    const t = newToken();
    users[t] = { name, created: Date.now() };
    await store.setJSON("users", users);
    return json({ token: t });
  }

  if (route === "people") {
    if (!user.owner) return json({ error: "Только тренер" }, 403);
    return json({ people: Object.entries(users).filter(([, u]) => !u.owner).map(([t, u]) => ({ token: t, name: u.name })) });
  }

  if (route === "revoke") {
    if (!user.owner) return json({ error: "Только тренер" }, 403);
    if (users[body.who] && !users[body.who].owner) { delete users[body.who]; await store.setJSON("users", users); }
    return json({ ok: true });
  }

  const histKey = "history/" + token;
  const history = (await store.get(histKey, { type: "json" })) || [];

  if (route === "history") return json({ name: user.name, owner: !!user.owner, history });

  if (route === "delete") {
    const left = history.filter(h => h.at !== body.at);
    await store.setJSON(histKey, left);
    return json({ history: left });
  }

  if (route === "analyze") {
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_PHOTOS) : [];
    if (!images.length) return json({ error: "Нет фото" }, 400);
    const today = new Date().toDateString();
    if (history.filter(h => new Date(h.at).toDateString() === today).length >= DAILY_LIMIT)
      return json({ error: "Лимит расчётов на сегодня исчерпан" }, 429);

    const content = [];
    images.forEach((img, i) => {
      content.push({ type: "text", text: "Фото " + (i + 1) + (img.time ? ", " + img.time : "") });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(img.data) } });
    });
    content.push({ type: "text", text: "Посчитай еду на этих фото." });

    const note = String(body.note || "").trim().slice(0, 500);
    if (note) content.push({ type: "text", text: "Подпись: " + note });
    const res = await askClaude(store, content);
    if (res.error) return json(res, 502);
    const entry = { at: Date.now(), n: images.length, ...(note ? { note } : {}), ...res };
    history.unshift(entry);
    await store.setJSON(histKey, history.slice(0, 500));
    return json({ entry });
  }

  if (route === "fix") {
    const e = history.find(h => h.at === body.at);
    if (!e) return json({ error: "Расчёт не найден" }, 404);
    const note = String(body.note || "").trim().slice(0, 500);
    if (!note) return json({ error: "Напиши, что исправить" }, 400);
    const res = await askClaude(store, [{ type: "text", text:
      "Прошлый расчёт по фото (фото уже нет, есть только этот текст):\n" + e.text +
      (e.note ? "\nПодпись к фото была: " + e.note : "") +
      "\n\nПоправка: " + note + "\nПересчитай." }]);
    if (res.error) return json(res, 502);
    Object.assign(e, res, { fixes: [...(e.fixes || []), note] });
    await store.setJSON(histKey, history);
    return json({ entry: e });
  }

  return json({ error: "Неизвестный запрос" }, 404);
}

// Поиск в интернете — только когда продукт неясен (см. правило в system prompt), не больше 10 запросов.
const TOOLS = [{ type: "web_search_20260209", name: "web_search", max_uses: 10, user_location: { type: "approximate", country: "RU" } }];

async function askClaude(store, content) {
  const key = await store.get("apiKey");
  const messages = [{ role: "user", content }];
  let data;
  for (let i = 0; i < 3; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2026-10-21",
        "anthropic-beta": "server-side-fallback-2026-07-01"
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4000, fallbacks: "default", output_config: { effort: "low" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS, messages
      })
    });
    data = await r.json();
    if (!r.ok) return { error: (data.error && data.error.message) || "Ошибка Claude API" };
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }
  if (data.stop_reason === "refusal") return { error: "Модель отказалась отвечать на эти фото" };
  // Берём текст после последнего поиска: до него модель могла написать «ищу…».
  const blocks = data.content;
  let from = 0;
  blocks.forEach((b, i) => { if (b.type === "web_search_tool_result") from = i + 1; });
  const raw = blocks.slice(from).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const m = raw.match(/#ИТОГ\s+ккал=(\d+)\s+б=(\d+)\s+ж=(\d+)\s+у=(\d+)/);
  return {
    text: raw.replace(/\n?#ИТОГ[^\n]*/g, "").trim(),
    totals: m ? { kcal: +m[1], p: +m[2], f: +m[3], c: +m[4] } : null
  };
}

// Отвечаем сразу и дописываем тело, когда Claude закончит: так не упираемся в 40 секунд до заголовков.
export default (req) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      const ping = setInterval(() => ctrl.enqueue(enc.encode(" ")), 10000);
      try {
        const res = await handle(req);
        ctrl.enqueue(enc.encode(await res.text()));
      } catch (e) {
        ctrl.enqueue(enc.encode(JSON.stringify({ error: "Сбой сервера: " + e.message })));
      } finally {
        clearInterval(ping);
        ctrl.close();
      }
    }
  });
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/*" };
