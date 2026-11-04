// Сервер страницы foto/ (Netlify Edge Function: ожидание ответа модели не тратит лимит времени).
// Считает через OpenRouter (Claude Sonnet; ключ в переменной OPENROUTER_API_KEY в Netlify), пускает по личным ссылкам,
// считает еду по фото и хранит историю каждого человека.
import { getStore } from "@netlify/blobs";
import { SYSTEM } from "../shared/system-prompt.js";

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
    return json({ configured: Object.values(users).some(u => u.owner), user: users[token] ? { name: users[token].name, owner: !!users[token].owner } : null });
  }
  if (route === "setup") {
    if (Object.values(users).some(u => u.owner)) return json({ error: "Сервер уже настроен" }, 409);
    if (!apiKey()) return json({ error: "Сначала добавь OPENROUTER_API_KEY в настройках Netlify" }, 400);
    const t = newToken();
    users[t] = { name: "Михаил", owner: true, created: Date.now() };
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
    const note = String(body.note || "").trim().slice(0, 500);
    if (!images.length && !note) return json({ error: "Нет фото и нет текста" }, 400);
    const today = new Date().toDateString();
    if (history.filter(h => new Date(h.created || h.at).toDateString() === today).length >= DAILY_LIMIT)
      return json({ error: "Лимит расчётов на сегодня исчерпан" }, 429);

    const content = [];
    images.forEach((img, i) => {
      content.push({ type: "text", text: "Фото " + (i + 1) + (img.time ? ", " + img.time : "") });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(img.data) } });
    });
    if (images.length) {
      content.push({ type: "text", text: "Посчитай еду на этих фото. Если на фото бутылка, банка или упаковка — считай весь её объём по этикетке, а не 100 мл или 100 г." });
      if (note) content.push({ type: "text", text: "Подпись: " + note });
    } else {
      content.push({ type: "text", text: "Фото нет, еда описана словами. Посчитай по описанию: если вес или объём не назван — бери типичную порцию и назови допущение.\nОписание: " + note });
    }
    const res = await askModel(content);
    if (res.error) return json(res, 502);
    // День записи: время съёмки с телефона (до 14 дней назад), иначе сейчас.
    const now = Date.now();
    let at = Number(body.at);
    if (!(at > now - 14 * 864e5 && at <= now + 3e5)) at = now;
    while (history.some(h => h.at === at)) at++;
    const entry = { at, created: now, n: images.length, ...(note ? { note } : {}), ...res };
    history.unshift(entry);
    history.sort((a, b) => b.at - a.at);
    await store.setJSON(histKey, history.slice(0, 500));
    return json({ entry });
  }

  if (route === "fix") {
    const e = history.find(h => h.at === body.at);
    if (!e) return json({ error: "Расчёт не найден" }, 404);
    const note = String(body.note || "").trim().slice(0, 500);
    if (!note) return json({ error: "Напиши, что исправить" }, 400);
    const res = await askModel([{ type: "text", text:
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

// Считаем через OpenRouter (по умолчанию Claude Sonnet 5.5). Ключ — переменная OPENROUTER_API_KEY в Netlify.
// Модель можно сменить переменной OPENROUTER_MODEL (через запятую — запасные, если первая недоступна).
const MODELS = () => (Netlify.env.get("OPENROUTER_MODEL") || "anthropic/claude-sonnet-5.5")
  .split(",").map(s => s.trim()).filter(Boolean);
const apiKey = () => Netlify.env.get("OPENROUTER_API_KEY") || "";
// Веб-поиск OpenRouter платный отдельно: включается переменной OPENROUTER_SEARCH=1.
const useSearch = () => Netlify.env.get("OPENROUTER_SEARCH") === "1";
const SYSTEM_NO_SEARCH = SYSTEM.replace(/ПОИСК В ИНТЕРНЕТЕ\n[^\n]*\n\n/, "");

async function askModel(content) {
  const key = apiKey();
  if (!key) return { error: "На сервере нет ключа OpenRouter (переменная OPENROUTER_API_KEY в Netlify)" };
  const parts = content.map(c => c.type === "image"
    ? { type: "image_url", image_url: { url: "data:" + c.source.media_type + ";base64," + c.source.data } }
    : { type: "text", text: c.text });
  const search = useSearch();
  const models = MODELS();
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + key,
      "HTTP-Referer": "https://hammer-kbzhu.netlify.app",
      "X-Title": "Hammer KBZHU"
    },
    body: JSON.stringify({
      model: models[0],
      ...(models.length > 1 ? { models } : {}),
      messages: [
        { role: "system", content: search ? SYSTEM : SYSTEM_NO_SEARCH },
        { role: "user", content: parts }
      ],
      ...(search ? { plugins: [{ id: "web", max_results: 3 }] } : {}),
      max_tokens: 4096,
      temperature: 0.4
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const msg = (data.error && data.error.message) || ("Ошибка OpenRouter " + r.status);
    if (r.status === 402) return { error: "На OpenRouter кончились деньги: пополни баланс" };
    if (r.status === 401) return { error: "OpenRouter не принял ключ: проверь OPENROUTER_API_KEY в Netlify" };
    return { error: msg };
  }
  const choice = (data.choices || [])[0];
  if (!choice || choice.finish_reason === "content_filter") return { error: "Модель отказалась отвечать на эти фото" };
  let raw = choice.message && choice.message.content;
  if (Array.isArray(raw)) raw = raw.map(p => p.text || "").join("");
  raw = String(raw || "").trim();
  if (!raw) return { error: "Пустой ответ модели, попробуй ещё раз" };
  const m = raw.match(/#ИТОГ\s+ккал=(\d+)\s+б=(\d+)\s+ж=(\d+)\s+у=(\d+)/);
  return {
    text: raw.replace(/\n?#ИТОГ[^\n]*/g, "").trim(),
    totals: m ? { kcal: +m[1], p: +m[2], f: +m[3], c: +m[4] } : null
  };
}

// Отвечаем сразу и дописываем тело, когда модель закончит: так не упираемся в 40 секунд до заголовков.
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
