// Замеры кисти: у каждого человека свои. По ним модель переводит «сколько ладоней» в сантиметры.
// Обязательны только длина кисти и ширина ладони; остальное, если не замерено, считаем по пропорциям.
export const HAND_FIELDS = [
  { id: "Lh", label: "Длина кисти", how: "складка запястья → кончик среднего пальца", min: 12, max: 25, need: true },
  { id: "Wp", label: "Ширина ладони по костяшкам", how: "без большого пальца", min: 6, max: 12, need: true },
  { id: "Lp", label: "Длина ладони", how: "складка запястья → основание среднего пальца", min: 7, max: 14, from: h => h.Lh * 0.56 },
  { id: "Lm", label: "Длина среднего пальца", how: "основание → кончик", min: 5, max: 11, from: h => h.Lh * 0.44 },
  { id: "Wi", label: "Ширина указательного пальца", how: "у среднего сустава", min: 1.2, max: 2.6, from: h => h.Wp * 0.21 },
  { id: "Wt", label: "Ширина большого пальца", how: "по ногтю", min: 1.4, max: 3.0, from: h => h.Wp * 0.24 },
  { id: "Lt", label: "Ногтевая фаланга большого пальца", how: "сгиб → кончик", min: 2.2, max: 4.8, from: h => h.Lh * 0.205 }
];

// Замеры Михаила (2026-10-31, рулетка и фото с рулеткой).
export const OWNER_HAND = { Lh: 17, Wp: 8.4, Lp: 9.5, Lm: 7.5, Wi: 1.8, Wt: 2.0, Lt: 3.5, k: 1 };

const num = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
};

// Проверяем и чистим то, что прислал телефон. Возвращает {hand} или {error}.
export function cleanHand(input) {
  const out = {};
  for (const f of HAND_FIELDS) {
    const v = num(input && input[f.id]);
    if (v === null) { if (f.need) return { error: "Нужно указать: " + f.label.toLowerCase() }; continue; }
    if (Number.isNaN(v) || v < f.min || v > f.max) return { error: f.label + ": похоже на опечатку. Нужно от " + f.min + " до " + f.max + " см" };
    out[f.id] = Math.round(v * 10) / 10;
  }
  const k = num(input && input.k);
  if (k !== null) {
    if (Number.isNaN(k) || k < 0.5 || k > 2) return { error: "Поправка k: от 0,5 до 2" };
    out.k = Math.round(k * 100) / 100;
  }
  return { hand: out };
}

export const handOf = user => (user && user.hand) || (user && user.owner ? OWNER_HAND : null);

const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace(/\.0+$/, "").replace(".", ",");

// Блок для системной инструкции модели.
export function handBlock(hand, name) {
  if (!hand) {
    return "ЗАМЕРЫ ЛАДОНИ\nНе указаны. Если в кадре ладонь — считай её средней ладонью взрослого (длина кисти ≈18 см, ширина по костяшкам ≈8,5 см) и снизь уверенность на ступень. Лучше опирайся на банковскую карту, тарелку, приборы, упаковку. В конце ответа одной фразой посоветуй заполнить замеры ладони в приложении.";
  }
  const lines = HAND_FIELDS.map(f => {
    const own = hand[f.id] != null;
    const v = own ? hand[f.id] : (f.from ? f.from(hand) : null);
    if (v == null) return null;
    return "- " + f.label + " (" + f.how + "): " + (own ? "" : "≈") + fmt(v) + (own ? "" : " (по пропорциям)");
  }).filter(Boolean);
  lines.push("- Личный поправочный коэффициент k: " + fmt(hand.k || 1, 2));
  return "ЗАМЕРЫ ЛАДОНИ" + (name ? " (" + name + ")" : "") + ", см\n" + lines.join("\n");
}
