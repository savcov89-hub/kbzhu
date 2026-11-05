// Частые продукты: проверенные КБЖУ на 100 г (с этикетки, из интернета, из поправки или вписанные тренером).
// Модель сверяется с этим списком при каждом расчёте, а новые цифры с этикеток сама дописывает строкой #ПРОДУКТ.

export const MAX_FOODS = 300;
const RANK = { "этикетка": 3, "вручную": 3, "поправка": 2, "интернет": 1 };

export const foodKey = name => String(name || "").toLowerCase().replace(/ё/g, "е")
  .replace(/[«»"'“”„()]/g, " ").replace(/[^a-zа-я0-9%,.]+/gi, " ").replace(/\s+/g, " ").trim();

const num = v => {
  const n = Number(String(v ?? "").replace(",", ".").replace(/[^\d.]/g, ""));
  return String(v ?? "").trim() === "" || !Number.isFinite(n) ? null : n;
};
const r1 = n => Math.round(n * 10) / 10;

// Проверяет и приводит запись к виду { key, name, kcal, p, f, c, pack, src, by, at }.
export function cleanFood(x) {
  x = x || {};
  const name = String(x.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (name.length < 2) return { error: "Нужно название продукта" };
  const kcal = num(x.kcal), p = num(x.p), f = num(x.f), c = num(x.c);
  if (kcal === null || kcal < 0 || kcal > 950) return { error: "Калории на 100 г: число от 0 до 950" };
  for (const v of [p, f, c]) if (v === null || v < 0 || v > 100) return { error: "Б, Ж и У на 100 г: числа от 0 до 100" };
  // Грубая проверка: калории не могут сильно расходиться с БЖУ (4/9/4 ккал на грамм).
  const est = p * 4 + f * 9 + c * 4;
  if (kcal > 20 && est > 0 && (est > kcal * 1.6 + 15 || est < kcal * 0.5 - 15)) return { error: "Калории не сходятся с БЖУ — проверь цифры" };
  const pack = num(x.pack);
  const src = RANK[x.src] ? x.src : "вручную";
  return { food: {
    key: foodKey(name), name, kcal: Math.round(kcal), p: r1(p), f: r1(f), c: r1(c),
    ...(pack && pack >= 1 && pack <= 5000 ? { pack: Math.round(pack) } : {}),
    src, ...(x.by ? { by: String(x.by).slice(0, 60) } : {}), at: Date.now()
  } };
}

// Строки вида: #ПРОДУКТ Творожок Ирменский малина-злаки 0,5% | 108 | 16 | 0,5 | 10 | 150 | этикетка
export function parseFoodTags(text, by) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*#ПРОДУКТ\s+(.+)$/);
    if (!m) continue;
    const [name, kcal, p, f, c, pack, src] = m[1].split("|").map(s => s.trim());
    const s = String(src || "").toLowerCase();
    const r = cleanFood({ name, kcal, p, f, c, pack, by,
      src: s.includes("этикет") ? "этикетка" : s.includes("поправ") ? "поправка" : s.includes("интернет") || s.includes("сайт") ? "интернет" : "" });
    // Оценки «на глаз» не запоминаем: только этикетка, интернет или поправка человека.
    if (r.food && r.food.src !== "вручную") out.push(r.food);
  }
  return out.slice(0, 10);
}

// Добавляет или обновляет записи. Цифры из более надёжного источника не затираются менее надёжными.
export function upsertFoods(list, add, { force = false } = {}) {
  const foods = Array.isArray(list) ? [...list] : [];
  for (const n of add) {
    const i = foods.findIndex(f => f.key === n.key);
    if (i < 0) { foods.unshift(n); continue; }
    if (force || (RANK[n.src] || 0) >= (RANK[foods[i].src] || 0)) foods[i] = { ...foods[i], ...n };
    else foods[i] = { ...foods[i], at: n.at };
  }
  return foods.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_FOODS);
}

const fmt = n => String(n).replace(".", ",");
// Блок для системной инструкции.
export function foodsBlock(foods) {
  if (!foods || !foods.length) return "Список пока пуст.";
  return foods.slice(0, 200).map(f =>
    "- " + f.name + ": " + f.kcal + " ккал, Б " + fmt(f.p) + " Ж " + fmt(f.f) + " У " + fmt(f.c) + " на 100 г" +
    (f.pack ? "; упаковка " + f.pack + " г" : "") + " (" + f.src + ")").join("\n");
}
