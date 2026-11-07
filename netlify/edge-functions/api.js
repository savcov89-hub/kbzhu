// Сервер страницы foto/ (Netlify Edge Function: ожидание ответа модели не тратит лимит времени).
// Считает через OpenRouter (Claude Sonnet; ключ в переменной OPENROUTER_API_KEY в Netlify), пускает по личным ссылкам,
// считает еду по фото и хранит историю и замеры ладони каждого человека.
import { getStore } from "@netlify/blobs";
import { buildSystem } from "../shared/system-prompt.js";
import { cleanHand, handOf, HAND_FIELDS } from "../shared/hand.js";
import { cleanFood, parseFoodTags, upsertFoods } from "../shared/foods.js";

const DAILY_LIMIT = 40;      // расчётов на человека в день
const MEASURE_LIMIT = 10;    // замеров ладони по фото на человека в день
const MAX_PHOTOS = 20;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const newToken = () => [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
const dayKey = () => new Date().toISOString().slice(0, 10);

async function handle(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, "");
  const store = getStore({ name: "foto", consistency: "strong" });
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const token = body.token || url.searchParams.get("t") || "";
  const users = (await store.get("users", { type: "json" })) || {};
  const me = u => ({ name: u.name, owner: !!u.owner, hand: handOf(u), handSet: !!(u.hand || u.owner) });

  // Первый запуск: владелец получает свою личную ссылку.
  if (route === "status") {
    return json({ configured: Object.values(users).some(u => u.owner), user: users[token] ? me(users[token]) : null });
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
    return json({ people: Object.entries(users).filter(([, u]) => !u.owner).map(([t, u]) => ({ token: t, name: u.name, hand: u.hand || null })) });
  }

  if (route === "revoke") {
    if (!user.owner) return json({ error: "Только тренер" }, 403);
    if (users[body.who] && !users[body.who].owner) { delete users[body.who]; await store.setJSON("users", users); }
    return json({ ok: true });
  }

  // Замеры ладони: свои — любой; чужие (клиента) — только тренер.
  if (route === "hand") {
    const who = body.who && body.who !== token ? body.who : token;
    if (who !== token && !user.owner) return json({ error: "Только тренер" }, 403);
    const target = users[who];
    if (!target) return json({ error: "Нет такого человека" }, 404);
    const r = cleanHand(body.hand);
    if (r.error) return json(r, 400);
    target.hand = r.hand;
    await store.setJSON("users", users);
    return json({ hand: target.hand });
  }

  // Замер ладони по фото с банковской картой: модель возвращает сантиметры, человек проверяет и сохраняет.
  if (route === "measure") {
    const img = String(body.image || "");
    if (!img) return json({ error: "Нет фото" }, 400);
    const today = dayKey();
    const m = user.measures && user.measures.day === today ? user.measures : { day: today, n: 0 };
    if (m.n >= MEASURE_LIMIT) return json({ error: "На сегодня замеров по фото хватит, введи цифры вручную" }, 429);
    user.measures = { day: today, n: m.n + 1 };
    await store.setJSON("users", users);
    const res = await callModel(MEASURE_SYSTEM, [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + img } },
      { type: "text", text: "Измерь кисть на этом фото." }
    ], 600, 0.1);
    if (res.error) return json(res, 502);
    const found = res.text.match(/\{[\s\S]*\}/);
    let data = null;
    try { data = found && JSON.parse(found[0]); } catch {}
    if (!data) return json({ error: "Не получилось разобрать замер, попробуй ещё раз или введи вручную" }, 502);
    if (data.ok === false) return json({ error: data.note || "На фото не видно кисть или карту целиком" }, 422);
    const hand = {};
    for (const f of HAND_FIELDS) {
      const v = Number(data[f.id]);
      if (Number.isFinite(v) && v >= f.min && v <= f.max) hand[f.id] = Math.round(v * 10) / 10;
    }
    if (!hand.Lh || !hand.Wp) return json({ error: "Не удалось точно измерить. Положи кисть и карту рядом, сними строго сверху" }, 422);
    return json({ hand, note: String(data.note || "").slice(0, 200) });
  }

  // Частые продукты: общий список проверенных КБЖУ, модель сверяется с ним при каждом расчёте.
  if (route === "foods") return json({ foods: await loadFoods(store) });
  if (route === "food-save" || route === "food-del") {
    if (!user.owner) return json({ error: "Только тренер" }, 403);
    let foods = await loadFoods(store);
    if (route === "food-del") foods = foods.filter(f => f.key !== body.key);
    else {
      const r = cleanFood({ ...body.food, src: "вручную" });
      if (r.error) return json(r, 400);
      if (body.key && body.key !== r.food.key) foods = foods.filter(f => f.key !== body.key);
      foods = upsertFoods(foods, [r.food], { force: true });
    }
    await store.setJSON("foods", foods);
    return json({ foods });
  }

  // Дневник клиента для тренера (только чтение).
  if (route === "client") {
    if (!user.owner) return json({ error: "Только тренер" }, 403);
    const c = users[body.who];
    if (!c || c.owner) return json({ error: "Нет такого клиента" }, 404);
    const h = (await store.get("history/" + body.who, { type: "json" })) || [];
    return json({ name: c.name, hand: c.hand || null, history: h.slice(0, 200) });
  }

  const histKey = "history/" + token;
  const history = (await store.get(histKey, { type: "json" })) || [];

  if (route === "history") return json({ ...me(user), history });

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
      content.push({ type: "text", text: "Посчитай еду на этих фото. Если видна этикетка с пищевой ценностью — бери цифры с неё. Если на фото бутылка, банка или упаковка — считай весь её объём по этикетке, а не 100 мл или 100 г. Одна и та же упаковка на нескольких фото (лицом, боком, этикеткой) — это одна штука." });
      if (note) content.push({ type: "text", text: "Подпись: " + note });
    } else {
      content.push({ type: "text", text: "Фото нет, еда описана словами. Посчитай по описанию: если вес или объём не назван — бери типичную порцию и назови допущение. Фирменный продукт (названа марка) сначала ищи в частых продуктах, нет там — найди его КБЖУ в интернете, а не бери «типичные» цифры.\nОписание: " + note });
    }
    const res = await askModel(content, user, store);
    if (res.error) return json(res, 502);
    // День записи: время съёмки с телефона (до 14 дней назад), иначе сейчас.
    const now = Date.now();
    let at = Number(body.at);
    if (!(at > now - 14 * 864e5 && at <= now + 3e5)) at = now;
    // Пока модель думала, могла прийти другая запись: перечитываем историю прямо перед сохранением.
    const fresh = (await store.get(histKey, { type: "json" })) || [];
    while (fresh.some(h => h.at === at)) at++;
    const entry = { at, created: now, n: images.length, ...(note ? { note } : {}), ...res };
    fresh.unshift(entry);
    fresh.sort((a, b) => b.at - a.at);
    await store.setJSON(histKey, fresh.slice(0, 500));
    return json({ entry });
  }

  // Перенос приёма на другой день или время (например, ел после полуночи — переносим на вчера).
  if (route === "move") {
    const now = Date.now();
    let to = Math.round(Number(body.to));
    if (!(to > now - 60 * 864e5 && to <= now + 3e5)) return json({ error: "Перенести можно только на последние 60 дней и не в будущее" }, 400);
    const fresh = (await store.get(histKey, { type: "json" })) || [];
    const e = fresh.find(h => h.at === body.at);
    if (!e) return json({ error: "Расчёт не найден" }, 404);
    while (fresh.some(h => h !== e && h.at === to)) to++;
    e.at = to;
    fresh.sort((a, b) => b.at - a.at);
    await store.setJSON(histKey, fresh);
    return json({ entry: e });
  }

  if (route === "fix") {
    const e = history.find(h => h.at === body.at);
    if (!e) return json({ error: "Расчёт не найден" }, 404);
    const note = String(body.note || "").trim().slice(0, 500);
    if (!note) return json({ error: "Напиши, что исправить" }, 400);
    const res = await askModel([{ type: "text", text:
      "Прошлый расчёт по фото (фото уже нет, есть только этот текст):\n" + e.text +
      (e.note ? "\nПодпись к фото была: " + e.note : "") +
      "\n\nПоправка: " + note + "\nПересчитай. Цифры из поправки (КБЖУ, вес, число штук) главнее прошлого расчёта и твоих оценок; если продукт фирменный, а точных цифр нет ни в поправке, ни в частых продуктах — найди их в интернете." }], user, store);
    if (res.error) return json(res, 502);
    const fresh = (await store.get(histKey, { type: "json" })) || [];
    const f = fresh.find(h => h.at === body.at);
    if (!f) return json({ error: "Расчёт уже удалён" }, 404);
    Object.assign(f, res, { fixes: [...(f.fixes || []), note] });
    await store.setJSON(histKey, fresh);
    return json({ entry: f });
  }

  return json({ error: "Неизвестный запрос" }, 404);
}

// Считаем через OpenRouter (по умолчанию Claude Sonnet 5.5). Ключ — переменная OPENROUTER_API_KEY в Netlify.
// Модель можно сменить переменной OPENROUTER_MODEL (через запятую — запасные, если первая недоступна).
const MODELS = () => (Netlify.env.get("OPENROUTER_MODEL") || "anthropic/claude-sonnet-5.5")
  .split(",").map(s => s.trim()).filter(Boolean);
const apiKey = () => Netlify.env.get("OPENROUTER_API_KEY") || "";
// Веб-поиск OpenRouter (инструмент openrouter:web_search, движок Exa ≈ $0,007 за поиск): модель ищет сама,
// только когда нужно сверить фирменный продукт. Выключить — переменная OPENROUTER_SEARCH=0.
const useSearch = () => Netlify.env.get("OPENROUTER_SEARCH") !== "0";
const SEARCH_TOOL = { type: "openrouter:web_search", parameters: { engine: "exa", max_results: 5, max_total_results: 12 } };

const MEASURE_SYSTEM = `Ты измеряешь кисть руки по фото. На фото кисть лежит на ровной поверхности, рядом эталон: банковская карта (8,56 × 5,40 см) или линейка/рулетка. Карта и кисть должны быть в одной плоскости; учти перспективу: если карта или кисть сняты под углом, поправь по форме карты (она прямоугольная).
Измерь в сантиметрах с одной десятичной:
Lh — длина кисти: от дистальной складки запястья до кончика среднего пальца;
Wp — ширина ладони по костяшкам (головки 2–5 пястных костей), без большого пальца;
Lp — длина ладони: от складки запястья до складки у основания среднего пальца;
Lm — длина среднего пальца: от складки у основания до кончика;
Wi — ширина указательного пальца у среднего сустава;
Wt — ширина большого пальца по ногтю;
Lt — длина ногтевой фаланги большого пальца: от сгиба до кончика.
Если какой-то замер не видно — null. Если нет эталона, кисть не целиком в кадре или снято сильно сбоку — ok=false и коротко причина в note.
Ответь строго одним JSON без пояснений и без markdown:
{"ok":true,"Lh":17.0,"Wp":8.4,"Lp":9.5,"Lm":7.5,"Wi":1.8,"Wt":2.0,"Lt":3.5,"note":"что мешало точности, коротко по-русски"}`;

async function callModel(system, parts, maxTokens, temperature) {
  const key = apiKey();
  if (!key) return { error: "На сервере нет ключа OpenRouter (переменная OPENROUTER_API_KEY в Netlify)" };
  const models = MODELS();
  const search = useSearch() && maxTokens > 1000;
  const send = withSearch => fetch("https://openrouter.ai/api/v1/chat/completions", {
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
      messages: [{ role: "system", content: system }, { role: "user", content: parts }],
      ...(withSearch ? { tools: [SEARCH_TOOL], max_tool_calls: 4 } : {}),
      max_tokens: maxTokens,
      temperature
    })
  });
  let r = await send(search);
  // Поиск не принят (400) — считаем без него, чтобы расчёт не сорвался.
  if (search && r.status === 400) r = await send(false);
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
  return { text: raw };
}

async function loadFoods(store) {
  const f = await store.get("foods", { type: "json" });
  return Array.isArray(f) ? f : [];
}

async function askModel(content, user, store) {
  const parts = content.map(c => c.type === "image"
    ? { type: "image_url", image_url: { url: "data:" + c.source.media_type + ";base64," + c.source.data } }
    : { type: "text", text: c.text });
  const foods = await loadFoods(store);
  const system = buildSystem({ name: user.name, owner: !!user.owner, hand: handOf(user), search: useSearch(), foods });
  const res = await callModel(system, parts, 4096, 0.3);
  if (res.error) return res;
  const raw = res.text;
  const m = raw.match(/#ИТОГ\s+ккал=(\d+)\s+б=(\d+)\s+ж=(\d+)\s+у=(\d+)/);
  // Цифры с этикетки, из интернета или из поправки модель отдаёт строкой #ПРОДУКТ — запоминаем в частые продукты.
  const learned = parseFoodTags(raw, user.name);
  if (learned.length) {
    try {
      const fresh = await loadFoods(store);
      await store.setJSON("foods", upsertFoods(fresh, learned));
    } catch {}
  }
  return {
    text: raw.replace(/\n?#(ИТОГ|ПРОДУКТ)[^\n]*/g, "").replace(/\n{3,}/g, "\n\n").trim(),
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
