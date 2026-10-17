(() => {
'use strict';

/* ---------- Настройки и хранилище ---------- */
const CFG = Object.assign({ club: 'Hammer Fit', trainerTelegram: '', fiberMin: 25 }, window.KBZHU_CONFIG || {});
const LS = 'kbzhu.v1.';
const store = {
  get(key, def) {
    try { const v = localStorage.getItem(LS + key); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(LS + key, JSON.stringify(val)); }
    catch (e) { toast('Не получилось сохранить: память браузера заполнена'); }
  }
};

const MEALS = [
  { id: 'breakfast', name: 'Завтрак', to: 'в завтрак' },
  { id: 'lunch', name: 'Обед', to: 'в обед' },
  { id: 'dinner', name: 'Ужин', to: 'в ужин' },
  { id: 'snack', name: 'Перекусы', to: 'в перекусы' }
];
const ACTIVITY = [
  [1.2, 'Без тренировок, сидячая работа'],
  [1.375, 'Тренировки 1–3 раза в неделю'],
  [1.55, 'Тренировки 3–5 раз в неделю'],
  [1.725, 'Тренировки 6–7 раз в неделю'],
  [1.9, 'Тяжёлый труд и тренировки']
];
const GOALS = [['lose', 'Похудение'], ['keep', 'Поддержание'], ['gain', 'Набор']];

const state = {
  date: isoDate(new Date()),
  profile: store.get('profile', null),
  diary: store.get('diary', {}),
  custom: store.get('custom', []),
  recent: store.get('recent', []),
  settings: store.get('settings', { trainer: CFG.trainerTelegram || '' }),
  foods: [],
  groups: [],
  dbReady: false,
  dbError: false
};

// Ник тренера можно передать ссылкой: .../?trainer=nick
(() => {
  const q = new URLSearchParams(location.search);
  const t = (q.get('trainer') || '').replace(/^@/, '').trim();
  if (t) { state.settings.trainer = t; store.set('settings', state.settings); }
})();

/* ---------- Утилиты ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const fmt = n => nf0.format(Math.round(n || 0));
const fmt1 = n => nf1.format(Math.round((n || 0) * 10) / 10);
const num = v => { const x = parseFloat(String(v).replace(',', '.').replace(/\s/g, '')); return isFinite(x) ? x : NaN; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function isoDate(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftDate(s, days) { const d = parseIso(s); d.setDate(d.getDate() + days); return isoDate(d); }
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WDS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
function dayLabel(s) {
  const today = isoDate(new Date());
  const d = parseIso(s);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (s === today) return `Сегодня, ${base}`;
  if (s === shiftDate(today, -1)) return `Вчера, ${base}`;
  if (s === shiftDate(today, 1)) return `Завтра, ${base}`;
  return `${WD[d.getDay()][0].toUpperCase() + WD[d.getDay()].slice(1)}, ${base}`;
}
function longDate(s) {
  const d = parseIso(s);
  const w = WD[d.getDay()];
  return `${w[0].toUpperCase() + w.slice(1)}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function shortDate(s) {
  const d = parseIso(s);
  return `${WDS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function mealByTime() {
  const h = new Date().getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 16) return 'lunch';
  if (h >= 16 && h < 21) return 'dinner';
  return 'snack';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- Нутриенты ---------- */
const KEYS = ['k', 'p', 'f', 'c', 'fb'];
function scale(per, grams) {
  const r = {};
  KEYS.forEach(k => { r[k] = (per[k] || 0) * grams / 100; });
  return r;
}
function sum(list) {
  const r = { k: 0, p: 0, f: 0, c: 0, fb: 0 };
  list.forEach(x => KEYS.forEach(k => { r[k] += x[k] || 0; }));
  return r;
}
const entryNutr = e => scale(e.per, e.grams);
const dayEntries = date => state.diary[date] || [];
const dayTotals = date => sum(dayEntries(date).map(entryNutr));

function calcTargets(p) {
  if (!p || !p.weight || !p.height || !p.age) return null;
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'f' ? -161 : 5);
  const tdee = bmr * (p.activity || 1.375);
  const k = Math.round(tdee * (p.goal === 'lose' ? 0.85 : p.goal === 'gain' ? 1.1 : 1) / 10) * 10;
  const prot = Math.round(p.weight * (p.goal === 'keep' ? 1.6 : 1.8));
  const fat = Math.round(p.weight * (p.goal === 'lose' ? 0.8 : 0.9));
  const carb = Math.max(50, Math.round((k - prot * 4 - fat * 9) / 4));
  const fb = Math.max(CFG.fiberMin, Math.round(k / 1000 * 14));
  return { k, p: prot, f: fat, c: carb, fb };
}
function targets() {
  const p = state.profile;
  if (!p) return null;
  if (p.manual && p.targets && p.targets.k) return p.targets;
  return calcTargets(p);
}

/* ---------- База продуктов и поиск ---------- */
const ENDINGS = ['иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ией', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ие', 'ые', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь', 'й'];
function normText(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9%]+/g, ' ').trim();
}
function stem(t) {
  if (t.length <= 3 || /\d/.test(t)) return t;
  for (const e of ENDINGS) if (t.length - e.length >= 3 && t.endsWith(e)) return t.slice(0, -e.length);
  return t;
}
const tokens = s => normText(s).split(' ').filter(Boolean).map(stem);

function indexFood(f) {
  f._n = normText(f.n);
  f._nt = tokens(f.n);
  f._at = tokens((f.a || []).join(' '));
  f._ap = (f.a || []).map(a => ({ t: tokens(a), n: normText(a) }));
  return f;
}

function lev1(a, b) {
  // true, если строки отличаются не больше чем на одну правку
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

function tokenScore(q, list, fuzzy) {
  let best = 0;
  for (const t of list) {
    let s = 0;
    if (t === q) s = 3;
    else if (t.startsWith(q)) s = 2.2;
    else if (q.length >= 5 && t.length >= 4 && t.slice(0, 4) === q.slice(0, 4) && Math.abs(t.length - q.length) <= 2) s = 1.2;
    else if (fuzzy && q.length >= 4 && (lev1(q, t) || (q.length >= 5 && t.length > q.length && lev1(q, t.slice(0, q.length))))) s = 1;
    if (s > best) best = s;
    if (best === 3) break;
  }
  return best;
}

function allFoods() { return state.custom.concat(state.foods); }

// Оценка одной фразы (название или синоним) против запроса. 0 — не подходит.
const LINKS = new Set(['с', 'со', 'по', 'в', 'на', 'из']);
function phraseScore(qt, qn, ph, fuzzy) {
  let total = 0;
  for (const q of qt) {
    const s = tokenScore(q, ph.t, fuzzy);
    if (!s) return 0;
    total += s;
  }
  if (ph.t[0] && tokenScore(qt[0], [ph.t[0]], fuzzy) >= 2.2) total += 3;
  if (ph.n.startsWith(qn)) total += 4;
  if (ph.n === qn) total += 3;
  total -= Math.max(0, ph.t.length - qt.length) * 0.35;
  // «Гречка с курицей» ниже просто гречки, если человек не писал «с»
  if (ph.t.some(t => t === 'с' || t === 'со' || t === 'по') && !qt.some(t => t === 'с' || t === 'со' || t === 'по')) total -= 1.6;
  return total;
}

function search(query, limit = 60) {
  const qn = normText(query);
  const qt = tokens(query).filter((t, i, arr) => !LINKS.has(t) || arr.length === 1);
  if (!qt.length) return [];
  const recentNames = new Set(state.recent.map(r => r.food.n));
  const wantsDry = qt.some(t => t.startsWith('сух') || t.startsWith('сыр'));
  const run = fuzzy => {
    const out = [];
    for (const f of allFoods()) {
      let best = phraseScore(qt, qn, { t: f._nt, n: f._n }, fuzzy);
      for (const a of f._ap) {
        const s = phraseScore(qt, qn, a, fuzzy) * 0.92;
        if (s > best) best = s;
      }
      if (!best && qt.length > 1) {
        // слова запроса разбросаны по названию и синонимам
        const pool = f._nt.concat(f._at);
        let s = 0;
        for (const q of qt) { const x = tokenScore(q, pool, fuzzy); if (!x) { s = 0; break; } s += x; }
        best = s * 0.7;
      }
      if (!best) continue;
      if (!wantsDry && f._nt.some(t => t === 'варен' || t === 'отварн')) best += 0.5;
      if (recentNames.has(f.n)) best += 1.5;
      if (f.src === 'custom') best += 1;
      best -= f._n.length / 100;
      out.push([best, f]);
    }
    return out;
  };
  let res = run(false);
  if (!res.length) res = run(true);
  res.sort((a, b) => b[0] - a[0]);
  return res.slice(0, limit).map(r => r[1]);
}

async function loadDb() {
  try {
    const r = await fetch('data/foods.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const db = await r.json();
    state.groups = db.groups;
    state.foods = db.items.map(row => indexFood({
      n: row[0], g: db.groups[row[1]], k: row[2], p: row[3], f: row[4], c: row[5], fb: row[6],
      a: row[7] ? row[7].split('|') : [], u: row[8] || [], src: 'base'
    }));
    state.dbReady = true;
  } catch (e) {
    state.dbError = true;
  }
  state.custom.forEach(indexFood);
  const v = sheet.top();
  if (v && v.onDb) v.onDb();
}

/* ---------- Сохранение ---------- */
function saveDiary() { store.set('diary', state.diary); }
function saveCustom() { store.set('custom', state.custom.map(({ _n, _nt, _at, _ap, ...rest }) => rest)); }
function rememberRecent(food, unit, qty) {
  const snap = { n: food.n, g: food.g, k: food.k, p: food.p, f: food.f, c: food.c, fb: food.fb, u: food.u || [], a: food.a || [], src: food.src, id: food.id };
  state.recent = [{ food: snap, unit, qty }].concat(state.recent.filter(r => r.food.n !== food.n)).slice(0, 40);
  store.set('recent', state.recent);
}

/* ---------- Главный экран ---------- */
function renderMain() {
  $('#clubName').textContent = CFG.club;
  $('#dayLabel').textContent = dayLabel(state.date);
  renderSummary();
  renderMeals();
}

function bar(color, value, target) {
  const pct = target ? Math.min(100, value / target * 100) : 0;
  return `<div class="mbar"><span style="width:${pct.toFixed(1)}%;background:var(--${color})"></span></div>`;
}

function renderSummary() {
  const t = targets();
  const tot = dayTotals(state.date);
  const el = $('#summary');
  const macro = (name, dot, color, val, tgt) => {
    const over = tgt && val > tgt * 1.05;
    return `<div class="macro">
      <div class="macro-top"><span class="macro-name"><span class="dot ${dot}"></span>${name}</span>
      <span class="macro-val"><b class="${over ? 'over' : ''}">${fmt(val)}</b>${tgt ? ` / ${fmt(tgt)}` : ''} г</span></div>
      ${bar(color, val, tgt)}
    </div>`;
  };
  const scaleK = Math.max(t ? t.k : 0, tot.k, 1);
  const seg = (v, cls) => `<span class="${cls}" style="width:${(v / scaleK * 100).toFixed(2)}%"></span>`;
  let head;
  if (t) {
    const left = t.k - tot.k;
    head = `<div class="sum-head">
      <div><div class="sum-big ${left < 0 ? 'over' : ''}">${fmt(Math.abs(left))}</div>
      <div class="sum-caption">${left < 0 ? 'ккал сверх нормы' : 'ккал осталось'}</div></div>
      <div class="sum-side">съедено <b>${fmt(tot.k)}</b><br>из ${fmt(t.k)} ккал</div>
    </div>`;
  } else {
    head = `<div class="sum-head">
      <div><div class="sum-big">${fmt(tot.k)}</div><div class="sum-caption">ккал съедено</div></div>
    </div>`;
  }
  el.innerHTML = head +
    `<div class="kcal-bar ${t && tot.k > t.k ? 'over' : ''}" role="img" aria-label="Калории: ${fmt(tot.k)}${t ? ' из ' + fmt(t.k) : ''}">
      ${seg(tot.p * 4, 'seg-p')}${seg(tot.f * 9, 'seg-f')}${seg(tot.c * 4, 'seg-c')}
    </div>
    <div class="macros">
      ${macro('Белки', 'dot-p', 'prot', tot.p, t && t.p)}
      ${macro('Жиры', 'dot-f', 'fat', tot.f, t && t.f)}
      ${macro('Углеводы', 'dot-c', 'carb', tot.c, t && t.c)}
      ${macro('Клетчатка', 'dot-fb', 'fiber', tot.fb, t && t.fb)}
    </div>` +
    (t ? '' : `<div class="no-norm"><span>Заполните профиль — посчитаем вашу норму</span><button class="btn btn-small btn-primary" data-act="profile">Посчитать</button></div>`);
}

function renderMeals() {
  const list = dayEntries(state.date);
  $('#meals').innerHTML = MEALS.map(m => {
    const items = list.filter(e => e.meal === m.id);
    const tot = sum(items.map(entryNutr));
    return `<section class="meal" aria-label="${m.name}">
      <div class="meal-head">
        <span class="meal-title">${m.name}</span>
        ${items.length ? `<span class="meal-kcal">${fmt(tot.k)} ккал</span>` : ''}
        <button class="add-btn" data-act="add" data-meal="${m.id}" aria-label="Добавить ${m.to}">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
        </button>
      </div>
      ${items.length ? `<ul class="entries">${items.map(e => {
        const n = entryNutr(e);
        return `<li class="entry" data-act="edit" data-id="${e.id}" tabindex="0" role="button">
          <div class="entry-main"><div class="entry-name">${esc(e.n)}</div>
          <div class="entry-sub">${esc(amountText(e))} · Б ${fmt(n.p)} Ж ${fmt(n.f)} У ${fmt(n.c)} Кл ${fmt(n.fb)}</div></div>
          <div class="entry-kcal">${fmt(n.k)}</div>
        </li>`;
      }).join('')}</ul>` : ''}
    </section>`;
  }).join('');
}

function amountText(e) {
  if (!e.unit || e.unit[0] === 'г') return `${fmt1(e.grams)} г`;
  return `${fmt1(e.qty)} × ${e.unit[0]} (${fmt(e.grams)} г)`;
}

/* ---------- Нижний лист ---------- */
const sheet = {
  stack: [],
  isOpen() { return this.stack.length > 0; },
  open(view) {
    const wasOpen = this.isOpen();
    this.stack = [view];
    if (!wasOpen) {
      $('#backdrop').hidden = false; $('#sheet').hidden = false;
      document.body.style.overflow = 'hidden';
    }
    history.pushState({ sheet: this.stack.length }, '');
    this.render(true);
  },
  push(view) { this.stack.push(view); history.pushState({ sheet: this.stack.length }, ''); this.render(true); },
  back() { history.back(); },
  close() { if (this.isOpen()) { closingAll = true; history.go(-this.stack.length); } },
  _pop() {
    this.stack.pop();
    if (!this.stack.length) this._hide(); else this.render(true);
  },
  _hide() {
    this.stack = [];
    $('#backdrop').hidden = true; $('#sheet').hidden = true;
    document.body.style.overflow = '';
    renderMain();
  },
  top() { return this.stack[this.stack.length - 1]; },
  render(focus) {
    const v = this.top(); if (!v) return;
    $('#sheetTitle').textContent = v.title;
    $('#sheetBack').hidden = this.stack.length < 2;
    const body = $('#sheetBody');
    v.render(body);
    if (focus) { body.scrollTop = 0; if (v.focus) setTimeout(() => { const el = $(v.focus, body); if (el) el.focus(); }, 60); }
  }
};
let closingAll = false;
window.addEventListener('popstate', () => {
  if (!sheet.isOpen()) return;
  if (closingAll) { closingAll = false; sheet._hide(); return; }
  sheet._pop();
});

/* ---------- Добавление: поиск ---------- */
function addView(meal, opts = {}) {
  const v = {
    title: opts.pick ? 'Ингредиент' : `Добавить ${MEALS.find(m => m.id === meal).to}`,
    focus: '.search',
    query: '', tab: 'recent', group: null,
    render(body) {
      body.innerHTML = `<div class="search-wrap">
          <input class="search" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Продукт или блюдо" value="${esc(v.query)}" aria-label="Поиск продукта или блюда">
          <div class="tabs" role="tablist" ${v.query ? 'hidden' : ''}>
            <button class="tab" role="tab" data-tab="recent" aria-selected="${v.tab === 'recent'}">Недавние</button>
            <button class="tab" role="tab" data-tab="mine" aria-selected="${v.tab === 'mine'}">Мои продукты</button>
            <button class="tab" role="tab" data-tab="catalog" aria-selected="${v.tab === 'catalog'}">Каталог</button>
          </div>
        </div>
        <div class="results"></div>`;
      const input = $('.search', body);
      const results = $('.results', body);
      const draw = () => drawResults(results, v, meal, opts);
      v.onDb = draw;
      input.addEventListener('input', () => {
        v.query = input.value; v.group = null;
        $('.tabs', body).hidden = !!v.query.trim();
        draw();
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
      $$('.tab', body).forEach(b => b.addEventListener('click', () => {
        v.tab = b.dataset.tab; v.group = null;
        $$('.tab', body).forEach(x => x.setAttribute('aria-selected', x === b));
        draw();
      }));
      draw();
    }
  };
  return v;
}

function foodRow(f, sub) {
  return `<li class="item" tabindex="0" role="button">
    <div class="item-main"><div class="item-name">${esc(f.n)}${f.src === 'custom' ? '<span class="tag">' + (f.recipe ? 'моё блюдо' : 'мой') + '</span>' : ''}</div>
    <div class="item-sub">${esc(sub != null ? sub : f.g)}</div></div>
    <div class="item-kcal">${fmt(f.k)}<small>ккал / 100 г</small></div>
  </li>`;
}

function drawResults(el, v, meal, opts) {
  const pick = f => {
    if (opts.pick) { opts.pick(f); return; }
    sheet.push(amountView(f, { meal }));
  };
  const bind = (list, onPick) => {
    $$('.item', el).forEach((li, i) => {
      const go = () => onPick(list[i]);
      li.addEventListener('click', go);
      li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  };
  const createButtons = opts.pick ? '' : `<div class="list-actions">
      <button class="btn btn-secondary btn-small" data-new="product">Создать продукт</button>
      <button class="btn btn-secondary btn-small" data-new="recipe">Собрать блюдо</button>
    </div>`;
  const bindCreate = () => {
    $$('[data-new]', el).forEach(b => b.addEventListener('click', () => {
      if (b.dataset.new === 'product') sheet.push(customView(null, { meal, name: v.query }));
      else sheet.push(recipeView(null, { meal, name: v.query }));
    }));
  };
  const q = v.query.trim();

  if (q) {
    if (!state.dbReady && !state.dbError) { el.innerHTML = '<p class="list-note">Загружаю базу продуктов…</p>'; return; }
    const res = search(q);
    if (!res.length) {
      el.innerHTML = `<p class="list-note">По запросу «${esc(q)}» ничего нет. Попробуйте короче, например одно слово, или добавьте свой продукт.</p>${createButtons}`;
      bindCreate();
      return;
    }
    el.innerHTML = `<ul class="list">${res.map(f => foodRow(f)).join('')}</ul>${createButtons}`;
    bind(res, pick); bindCreate();
    return;
  }

  if (v.tab === 'recent') {
    const rec = state.recent;
    if (!rec.length) {
      el.innerHTML = `<p class="list-note">Здесь появятся продукты, которые вы добавляли. Начните с поиска: «гречка», «грудка», «борщ».</p>${createButtons}`;
      bindCreate(); return;
    }
    el.innerHTML = `<ul class="list">${rec.map(r => foodRow(r.food, r.unit && r.unit[0] !== 'г' ? `${fmt1(r.qty)} × ${r.unit[0]}` : `${fmt(r.qty)} г`)).join('')}</ul>${createButtons}`;
    bind(rec, r => {
      const food = indexFood(Object.assign({}, r.food));
      if (opts.pick) opts.pick(food); else sheet.push(amountView(food, { meal, unit: r.unit, qty: r.qty }));
    });
    bindCreate();
    return;
  }

  if (v.tab === 'mine') {
    const mine = state.custom;
    el.innerHTML = (mine.length ? `<ul class="list">${mine.map(f => foodRow(f, f.recipe ? 'Своё блюдо' : 'Свой продукт')).join('')}</ul>`
      : '<p class="list-note">Своих продуктов пока нет. Добавьте продукт с упаковки или соберите блюдо по рецепту.</p>') + createButtons;
    bind(mine, pick); bindCreate();
    return;
  }

  // Каталог
  if (!state.dbReady) { el.innerHTML = `<p class="list-note">${state.dbError ? 'База не загрузилась. Проверьте интернет и откройте приложение заново.' : 'Загружаю базу продуктов…'}</p>`; return; }
  if (v.group == null) {
    const counts = {};
    state.foods.forEach(f => { counts[f.g] = (counts[f.g] || 0) + 1; });
    el.innerHTML = `<ul class="list">${state.groups.filter(g => counts[g]).map(g => `<li class="item" tabindex="0" role="button" data-group="${esc(g)}">
      <div class="item-main"><div class="item-name">${esc(g)}</div></div><div class="item-sub">${counts[g]}</div></li>`).join('')}</ul>`;
    $$('[data-group]', el).forEach(li => {
      const go = () => { v.group = li.dataset.group; drawResults(el, v, meal, opts); $('#sheetBody').scrollTop = 0; };
      li.addEventListener('click', go);
      li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
    return;
  }
  const items = state.foods.filter(f => f.g === v.group).sort((a, b) => a.n.localeCompare(b.n, 'ru'));
  el.innerHTML = `<button class="btn btn-ghost btn-small" data-allgroups>← Все разделы</button>
    <h3 class="group-title">${esc(v.group)}</h3><ul class="list">${items.map(f => foodRow(f, '')).join('')}</ul>`;
  $('[data-allgroups]', el).addEventListener('click', () => { v.group = null; drawResults(el, v, meal, opts); });
  bind(items, pick);
}

/* ---------- Добавление: количество ---------- */
function amountView(food, opts = {}) {
  const entry = opts.entry || null;
  const units = [['г', 1]].concat((food.u || []).filter(u => u && u[1] > 0));
  let unit = null, qty = null;
  const want = opts.unit || (entry && entry.unit);
  if (want) unit = units.find(u => u[0] === want[0] && Math.abs(u[1] - want[1]) < 0.01) || null;
  if (unit) qty = opts.qty != null ? opts.qty : entry ? (unit[0] === 'г' ? entry.grams : entry.qty) : null;
  else if (entry) { unit = units[0]; qty = entry.grams; }
  if (!unit) unit = units.length > 1 ? units[1] : units[0];
  if (qty == null || !(qty > 0)) qty = unit[0] === 'г' ? 100 : 1;
  let meal = (entry && entry.meal) || opts.meal || mealByTime();

  const v = {
    title: entry ? 'Изменить запись' : 'Сколько съели',
    focus: entry ? null : '.amount-input',
    render(body) {
      body.innerHTML = `<div class="food-card">
          <div class="food-name">${esc(food.n)}</div>
          <div class="food-per">На 100 г: ${fmt(food.k)} ккал · Б ${fmt1(food.p)} · Ж ${fmt1(food.f)} · У ${fmt1(food.c)} · Кл ${fmt1(food.fb)}</div>
        </div>
        <div class="amount-row">
          <input class="amount-input" type="text" inputmode="decimal" autocomplete="off" aria-label="Количество" value="${esc(String(qty).replace('.', ','))}">
          <div class="amount-unit" aria-live="polite"></div>
        </div>
        <div class="chips" role="group" aria-label="Единица">${units.map((u, i) => `<button class="chip" data-u="${i}" aria-pressed="${u === unit}">${u[0] === 'г' ? 'граммы' : `${esc(u[0])} · ${fmt(u[1])} г`}</button>`).join('')}</div>
        <div class="result" aria-live="polite"></div>
        <span class="field-label">Приём пищи</span>
        <div class="segmented" role="group" aria-label="Приём пищи">${MEALS.map(m => `<button data-meal="${m.id}" aria-pressed="${m.id === meal}">${m.name}</button>`).join('')}</div>
        <p class="error" hidden></p>
        <div class="actions">
          <button class="btn btn-primary" data-save>${entry ? 'Сохранить' : 'Добавить'}</button>
          ${entry ? '<button class="btn btn-danger" data-del>Удалить из дневника</button>' : ''}
          ${food.src === 'custom' && !entry ? '<button class="btn btn-ghost btn-small" data-editcustom>Изменить мой продукт</button>' : ''}
        </div>`;
      const input = $('.amount-input', body);
      const unitEl = $('.amount-unit', body);
      const resEl = $('.result', body);
      const grams = () => { const q = num(input.value); return isFinite(q) && q > 0 ? q * unit[1] : 0; };
      const draw = () => {
        unitEl.textContent = unit[0] === 'г' ? 'г' : unit[0];
        const g = grams();
        const n = scale(food, g);
        resEl.innerHTML = `<div class="r-k"><b>${fmt(n.k)}</b><span>ккал</span></div>
          <div><b>${fmt1(n.p)}</b><span>белки</span></div><div><b>${fmt1(n.f)}</b><span>жиры</span></div>
          <div><b>${fmt1(n.c)}</b><span>углев.</span></div><div><b>${fmt1(n.fb)}</b><span>клетч.</span></div>`;
        if (unit[0] !== 'г') resEl.setAttribute('title', `${fmt(g)} г`);
      };
      input.addEventListener('input', draw);
      input.addEventListener('focus', () => input.select());
      input.addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-save]', body).click(); });
      $$('.chip', body).forEach(b => b.addEventListener('click', () => {
        const next = units[+b.dataset.u];
        if (next === unit) return;
        const g = grams();
        unit = next;
        qty = unit[0] === 'г' ? Math.round(g || 100) : (g ? Math.round(g / unit[1] * 10) / 10 || 1 : 1);
        if (unit[0] !== 'г' && g && Math.abs(qty - Math.round(qty)) < 0.05) qty = Math.round(qty) || 1;
        input.value = String(qty).replace('.', ',');
        $$('.chip', body).forEach(x => x.setAttribute('aria-pressed', x === b));
        draw();
      }));
      $$('.segmented button', body).forEach(b => b.addEventListener('click', () => {
        meal = b.dataset.meal;
        $$('.segmented button', body).forEach(x => x.setAttribute('aria-pressed', x === b));
      }));
      $('[data-save]', body).addEventListener('click', () => {
        const q = num(input.value);
        const err = $('.error', body);
        if (!isFinite(q) || q <= 0) { err.textContent = 'Введите количество больше нуля'; err.hidden = false; input.focus(); return; }
        if (q * unit[1] > 5000) { err.textContent = 'Больше 5 кг за раз — проверьте число'; err.hidden = false; input.focus(); return; }
        const rec = {
          id: entry ? entry.id : uid(), meal, n: food.n, grams: Math.round(q * unit[1] * 10) / 10,
          unit: [unit[0], unit[1]], qty: q,
          per: { k: food.k, p: food.p, f: food.f, c: food.c, fb: food.fb }, src: food.src || 'base'
        };
        const list = (state.diary[state.date] = state.diary[state.date] || []);
        if (entry) {
          const i = list.findIndex(e => e.id === entry.id);
          if (i >= 0) list[i] = rec;
        } else list.push(rec);
        saveDiary();
        rememberRecent(food, rec.unit, q);
        toast(entry ? 'Сохранено' : `Добавлено: ${fmt(scale(food, rec.grams).k)} ккал`);
        sheet.close();
      });
      if (entry) $('[data-del]', body).addEventListener('click', () => {
        state.diary[state.date] = dayEntries(state.date).filter(e => e.id !== entry.id);
        if (!state.diary[state.date].length) delete state.diary[state.date];
        saveDiary();
        toast('Удалено из дневника');
        sheet.close();
      });
      const ec = $('[data-editcustom]', body);
      if (ec) ec.addEventListener('click', () => {
        const orig = state.custom.find(c => c.id === food.id);
        if (!orig) return;
        sheet.push(orig.recipe ? recipeView(orig, { meal }) : customView(orig, { meal }));
      });
      draw();
    }
  };
  return v;
}

/* ---------- Свой продукт ---------- */
function customView(existing, opts = {}) {
  const d = existing ? Object.assign({}, existing) : { n: opts.name || '', k: '', p: '', f: '', c: '', fb: '', u: [] };
  const portion = (d.u && d.u[0]) || ['', ''];
  return {
    title: existing ? 'Мой продукт' : 'Новый продукт',
    focus: existing ? null : '#cName',
    render(body) {
      body.innerHTML = `<p class="hint" style="margin-top:4px">Перепишите цифры с упаковки — они указаны на 100 г.</p>
        <div class="form">
          <label class="field-label" for="cName">Название</label>
          <input class="input" id="cName" value="${esc(d.n)}" placeholder="Например, Творог «Савушкин» 5%" autocomplete="off">
          <label class="field-label" for="cK">Калории на 100 г</label>
          <input class="input" id="cK" inputmode="decimal" value="${esc(d.k)}" placeholder="Посчитаем сами, если пусто">
          <div class="row2">
            <div><label class="field-label" for="cP">Белки, г</label><input class="input" id="cP" inputmode="decimal" value="${esc(d.p)}"></div>
            <div><label class="field-label" for="cF">Жиры, г</label><input class="input" id="cF" inputmode="decimal" value="${esc(d.f)}"></div>
          </div>
          <div class="row2">
            <div><label class="field-label" for="cC">Углеводы, г</label><input class="input" id="cC" inputmode="decimal" value="${esc(d.c)}"></div>
            <div><label class="field-label" for="cFb">Клетчатка, г</label><input class="input" id="cFb" inputmode="decimal" value="${esc(d.fb)}" placeholder="0"></div>
          </div>
          <label class="field-label" for="cUl">Порция (необязательно)</label>
          <div class="row2">
            <input class="input" id="cUl" value="${esc(portion[0])}" placeholder="шт, пачка, батончик">
            <input class="input" id="cUg" inputmode="decimal" value="${esc(portion[1])}" placeholder="граммов в порции">
          </div>
        </div>
        <p class="error" hidden></p>
        <div class="actions">
          <button class="btn btn-primary" data-save>${existing ? 'Сохранить' : 'Сохранить и добавить'}</button>
          ${existing ? '<button class="btn btn-danger" data-del>Удалить продукт</button>' : ''}
        </div>`;
      const val = id => num($(id, body).value);
      $('[data-save]', body).addEventListener('click', () => {
        const err = $('.error', body);
        const name = $('#cName', body).value.trim();
        const p = val('#cP') || 0, f = val('#cF') || 0, c = val('#cC') || 0, fb = val('#cFb') || 0;
        let k = val('#cK');
        if (!name) { err.textContent = 'Введите название'; err.hidden = false; return; }
        if (!isFinite(k)) k = Math.round(p * 4 + f * 9 + c * 4 + fb * 2);
        if (k < 0 || k > 950 || p + f + c + fb > 105) { err.textContent = 'Цифры не похожи на значения на 100 г — проверьте'; err.hidden = false; return; }
        const ul = $('#cUl', body).value.trim(), ug = val('#cUg');
        const food = indexFood({
          id: existing ? existing.id : 'c' + uid(), src: 'custom', n: name, g: 'Мои продукты',
          k, p, f, c, fb, a: [], u: ul && ug > 0 ? [[ul, ug]] : []
        });
        if (existing) state.custom = state.custom.map(x => x.id === existing.id ? food : x);
        else state.custom.unshift(food);
        saveCustom();
        if (existing) { toast('Продукт сохранён'); sheet.close(); return; }
        sheet.stack.pop();
        history.replaceState({ sheet: sheet.stack.length + 1 }, '');
        sheet.stack.push(amountView(food, { meal: opts.meal }));
        sheet.render(true);
      });
      if (existing) $('[data-del]', body).addEventListener('click', () => {
        state.custom = state.custom.filter(x => x.id !== existing.id);
        saveCustom();
        toast('Продукт удалён. Записи в дневнике остались.');
        sheet.close();
      });
    }
  };
}

/* ---------- Своё блюдо по рецепту ---------- */
function recipeView(existing, opts = {}) {
  const r = existing ? JSON.parse(JSON.stringify(existing.recipe)) : { items: [], cooked: '' };
  let name = existing ? existing.n : (opts.name || '');
  const v = {
    title: existing ? 'Моё блюдо' : 'Новое блюдо',
    render(body) {
      const calc = () => {
        const raw = r.items.reduce((s, i) => s + (i.grams || 0), 0);
        const cooked = num(r.cooked) > 0 ? num(r.cooked) : raw;
        const tot = sum(r.items.map(i => scale(i.per, i.grams || 0)));
        const per = cooked > 0 ? scale(tot, 100 * 100 / cooked) : { k: 0, p: 0, f: 0, c: 0, fb: 0 };
        return { raw, cooked, tot, per };
      };
      const { raw } = calc();
      body.innerHTML = `<div class="form">
          <label class="field-label" for="rName">Название</label>
          <input class="input" id="rName" value="${esc(name)}" placeholder="Например, Мамин борщ" autocomplete="off">
        </div>
        <span class="field-label">Ингредиенты в сыром виде</span>
        ${r.items.length ? `<ul class="list ing-list">${r.items.map((i, idx) => `<li class="item">
            <div class="item-main"><div class="item-name">${esc(i.n)}</div><div class="item-sub" data-kc="${idx}"></div></div>
            <input class="ing-grams" inputmode="decimal" data-idx="${idx}" value="${esc(String(i.grams).replace('.', ','))}" aria-label="Граммы: ${esc(i.n)}">
            <button class="ing-del" data-del="${idx}" aria-label="Убрать ${esc(i.n)}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
          </li>`).join('')}</ul>` : '<p class="list-note">Добавьте всё, что кладёте в кастрюлю, включая масло.</p>'}
        <div class="actions" style="margin-top:10px"><button class="btn btn-secondary" data-addi>Добавить ингредиент</button></div>
        <label class="field-label" for="rCooked">Вес готового блюда, г</label>
        <input class="input" id="rCooked" inputmode="decimal" value="${esc(r.cooked)}" placeholder="${raw ? fmt(raw) + ' — если не взвешивали' : 'Взвесьте без кастрюли'}">
        <p class="hint">При варке крупы набирают воду, при жарке мясо теряет. Взвесьте готовое блюдо, и калории на 100 г будут точными.</p>
        <div class="norm-card" aria-live="polite"></div>
        <p class="error" hidden></p>
        <div class="actions">
          <button class="btn btn-primary" data-save>${existing ? 'Сохранить' : 'Сохранить и добавить'}</button>
          ${existing ? '<button class="btn btn-danger" data-delr>Удалить блюдо</button>' : ''}
        </div>`;
      const drawTotals = () => {
        const { raw, cooked, tot, per } = calc();
        $('.norm-card', body).innerHTML = `<div class="norm-kcal">${fmt(per.k)}<small>ккал на 100 г</small></div>
          <div class="food-per">Б ${fmt1(per.p)} · Ж ${fmt1(per.f)} · У ${fmt1(per.c)} · Кл ${fmt1(per.fb)}<br>Всего ${fmt(tot.k)} ккал в ${fmt(cooked)} г</div>`;
        $('#rCooked', body).placeholder = raw ? `${fmt(raw)} — если не взвешивали` : 'Взвесьте без кастрюли';
        $$('[data-kc]', body).forEach(el => { const i = r.items[+el.dataset.kc]; el.textContent = `${fmt(i.per.k * (i.grams || 0) / 100)} ккал`; });
      };
      $('#rName', body).addEventListener('input', e => { name = e.target.value; });
      $('#rCooked', body).addEventListener('input', e => { r.cooked = e.target.value; drawTotals(); });
      $$('.ing-grams', body).forEach(inp => inp.addEventListener('input', () => {
        const g = num(inp.value); r.items[+inp.dataset.idx].grams = g > 0 ? g : 0; drawTotals();
      }));
      $$('[data-del]', body).forEach(b => b.addEventListener('click', () => { r.items.splice(+b.dataset.del, 1); v.render(body); }));
      drawTotals();
      $('[data-addi]', body).addEventListener('click', () => {
        sheet.push(addView(opts.meal || 'lunch', {
          pick: f => {
            const u = (f.u && f.u[0]) ? f.u[0][1] : 100;
            r.items.push({ n: f.n, grams: u, per: { k: f.k, p: f.p, f: f.f, c: f.c, fb: f.fb } });
            sheet.back();
          }
        }));
      });
      $('[data-save]', body).addEventListener('click', () => {
        const err = $('.error', body);
        const { cooked, per } = calc();
        if (!name.trim()) { err.textContent = 'Введите название блюда'; err.hidden = false; return; }
        if (!r.items.length || !(cooked > 0)) { err.textContent = 'Добавьте хотя бы один ингредиент с весом'; err.hidden = false; return; }
        const round1 = x => Math.round(x * 10) / 10;
        const food = indexFood({
          id: existing ? existing.id : 'c' + uid(), src: 'custom', n: name.trim(), g: 'Мои продукты',
          k: Math.round(per.k), p: round1(per.p), f: round1(per.f), c: round1(per.c), fb: round1(per.fb),
          a: [], u: [['порция', 250]], recipe: { items: r.items, cooked: r.cooked }
        });
        if (existing) state.custom = state.custom.map(x => x.id === existing.id ? food : x);
        else state.custom.unshift(food);
        saveCustom();
        if (existing) { toast('Блюдо сохранено'); sheet.close(); return; }
        sheet.stack.pop();
        history.replaceState({ sheet: sheet.stack.length + 1 }, '');
        sheet.stack.push(amountView(food, { meal: opts.meal }));
        sheet.render(true);
      });
      if (existing) $('[data-delr]', body).addEventListener('click', () => {
        state.custom = state.custom.filter(x => x.id !== existing.id);
        saveCustom();
        toast('Блюдо удалено. Записи в дневнике остались.');
        sheet.close();
      });
    }
  };
  return v;
}

/* ---------- Профиль и норма ---------- */
function profileView() {
  const p = Object.assign({ name: '', sex: 'm', age: '', height: '', weight: '', activity: 1.375, goal: 'lose', manual: false, targets: null }, state.profile || {});
  let trainer = state.settings.trainer || '';
  const v = {
    title: 'Профиль и норма',
    render(body) {
      body.innerHTML = `<div class="form">
          <label class="field-label" for="pName">Имя и фамилия — их увидит тренер в отчёте</label>
          <input class="input" id="pName" value="${esc(p.name)}" autocomplete="name" placeholder="Иван Петров">
          <span class="field-label">Пол</span>
          <div class="segmented two" data-seg="sex">
            <button data-v="m" aria-pressed="${p.sex === 'm'}">Мужской</button>
            <button data-v="f" aria-pressed="${p.sex === 'f'}">Женский</button>
          </div>
          <div class="row3">
            <div><label class="field-label" for="pAge">Возраст</label><input class="input" id="pAge" inputmode="numeric" value="${esc(p.age)}"></div>
            <div><label class="field-label" for="pH">Рост, см</label><input class="input" id="pH" inputmode="numeric" value="${esc(p.height)}"></div>
            <div><label class="field-label" for="pW">Вес, кг</label><input class="input" id="pW" inputmode="decimal" value="${esc(String(p.weight).replace('.', ','))}"></div>
          </div>
          <label class="field-label" for="pAct">Активность</label>
          <select class="select" id="pAct">${ACTIVITY.map(([k, l]) => `<option value="${k}" ${+p.activity === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="field-label">Цель</span>
          <div class="segmented three" data-seg="goal">${GOALS.map(([k, l]) => `<button data-v="${k}" aria-pressed="${p.goal === k}">${l}</button>`).join('')}</div>
        </div>
        <div class="norm-card">
          <div id="pNorm" aria-live="polite"></div>
          <label class="switch-row"><span>Норму задал тренер</span><input type="checkbox" id="pManual" ${p.manual ? 'checked' : ''}></label>
        </div>
        <label class="field-label" for="pTrainer">Telegram тренера</label>
        <input class="input" id="pTrainer" value="${esc(trainer)}" placeholder="ник без @" autocapitalize="off" autocomplete="off">
        <p class="error" hidden></p>
        <div class="actions"><button class="btn btn-primary" data-save>Сохранить</button></div>
        <div class="section-sep"></div>
        <span class="field-label">Копия дневника</span>
        <p class="hint">Записи хранятся только в этом телефоне. Перед сменой телефона или очисткой браузера сохраните копию, потом восстановите её.</p>
        <div class="list-actions">
          <button class="btn btn-secondary btn-small" data-export>Сохранить копию</button>
          <button class="btn btn-secondary btn-small" data-import>Восстановить</button>
        </div>
        <input type="file" id="pFile" accept="application/json,.json" hidden>
        <p class="hint">Чтобы открывать как приложение: в браузере нажмите «Поделиться» или меню ⋮ и выберите «На экран Домой».</p>`;

      const read = () => {
        p.name = $('#pName', body).value.trim();
        p.age = $('#pAge', body).value.trim(); p.height = $('#pH', body).value.trim(); p.weight = $('#pW', body).value.trim();
        p.activity = +$('#pAct', body).value;
        trainer = $('#pTrainer', body).value.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').trim();
        if (p.manual) {
          p.targets = p.targets || {};
          $$('[data-t]', body).forEach(i => { p.targets[i.dataset.t] = num(i.value) || 0; });
        }
      };
      const auto = () => calcTargets({ ...p, age: num(p.age), height: num(p.height), weight: num(p.weight) });
      // Перерисовывается только блок нормы, поля формы не трогаем — иначе на телефоне слетает фокус и клавиатура.
      const drawNorm = () => {
        const box = $('#pNorm', body);
        if (p.manual) {
          const t = p.targets || {};
          box.innerHTML = `<div class="food-per" style="margin:0 0 4px">Впишите норму от тренера, на день:</div>
            <div class="norm-macros">
              <label><span>Ккал</span><input class="input" data-t="k" inputmode="numeric" value="${esc(t.k)}"></label>
              <label><span><i class="dot dot-p"></i>Белки</span><input class="input" data-t="p" inputmode="numeric" value="${esc(t.p)}"></label>
              <label><span><i class="dot dot-f"></i>Жиры</span><input class="input" data-t="f" inputmode="numeric" value="${esc(t.f)}"></label>
              <label><span><i class="dot dot-c"></i>Углев.</span><input class="input" data-t="c" inputmode="numeric" value="${esc(t.c)}"></label>
            </div>
            <div class="norm-macros"><label><span><i class="dot dot-fb"></i>Клетч.</span><input class="input" data-t="fb" inputmode="numeric" value="${esc(t.fb)}"></label></div>`;
          return;
        }
        const t = auto();
        box.innerHTML = t
          ? `<div class="norm-kcal">${fmt(t.k)}<small>ккал в день</small></div>
             <div class="food-per">Белки ${fmt(t.p)} г · Жиры ${fmt(t.f)} г · Углеводы ${fmt(t.c)} г · Клетчатка ${fmt(t.fb)} г</div>`
          : '<div class="food-per" style="margin:0">Заполните возраст, рост и вес — норма посчитается сама.</div>';
      };
      const onInput = () => { read(); if (!p.manual) drawNorm(); };
      ['#pAge', '#pH', '#pW'].forEach(id => $(id, body).addEventListener('input', onInput));
      $('#pAct', body).addEventListener('change', onInput);
      $$('[data-seg]', body).forEach(seg => $$('button', seg).forEach(b => b.addEventListener('click', () => {
        p[seg.dataset.seg] = b.dataset.v;
        $$('button', seg).forEach(x => x.setAttribute('aria-pressed', x === b));
        onInput();
      })));
      $('#pManual', body).addEventListener('change', e => {
        read();
        p.manual = e.target.checked;
        if (p.manual && (!p.targets || !p.targets.k)) {
          p.targets = auto() || { k: 2000, p: 120, f: 65, c: 230, fb: CFG.fiberMin };
        }
        drawNorm();
      });
      drawNorm();
      $('[data-save]', body).addEventListener('click', () => {
        read();
        const err = $('.error', body);
        const age = num(p.age), h = num(p.height), w = num(p.weight);
        if ((p.age && !(age >= 12 && age <= 100)) || (p.height && !(h >= 120 && h <= 230)) || (p.weight && !(w >= 30 && w <= 300))) {
          err.textContent = 'Проверьте возраст (12–100), рост (120–230 см) и вес (30–300 кг)'; err.hidden = false; return;
        }
        if (p.manual && !(p.targets && p.targets.k > 0)) { err.textContent = 'Введите норму калорий'; err.hidden = false; return; }
        state.profile = { ...p, age: age || '', height: h || '', weight: w || '' };
        store.set('profile', state.profile);
        state.settings.trainer = trainer;
        store.set('settings', state.settings);
        toast('Профиль сохранён');
        sheet.close();
      });
      $('[data-export]', body).addEventListener('click', exportBackup);
      $('[data-import]', body).addEventListener('click', () => $('#pFile', body).click());
      $('#pFile', body).addEventListener('change', e => importBackup(e.target.files[0]));
    }
  };
  return v;
}

function exportBackup() {
  const data = {
    app: 'kbzhu', version: 1, exported: new Date().toISOString(),
    profile: state.profile, diary: state.diary, recent: state.recent, settings: state.settings,
    custom: state.custom.map(({ _n, _nt, _at, _ap, ...rest }) => rest)
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dnevnik-pitaniya-${isoDate(new Date())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Копия сохранена в загрузки');
}
function importBackup(file) {
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (d.app !== 'kbzhu') throw new Error('format');
      if (!confirm('Восстановить копию? Текущие записи в этом телефоне заменятся записями из файла.')) return;
      state.profile = d.profile || null; state.diary = d.diary || {}; state.recent = d.recent || [];
      state.custom = (d.custom || []).map(indexFood); state.settings = d.settings || state.settings;
      store.set('profile', state.profile); saveDiary(); store.set('recent', state.recent); saveCustom(); store.set('settings', state.settings);
      toast('Копия восстановлена');
      sheet.close();
    } catch (e) { toast('Это не файл копии дневника'); }
  };
  fr.readAsText(file);
}

/* ---------- Отчёт тренеру ---------- */
function pct(v, t) { return t ? ` (${Math.round(v / t * 100)}%)` : ''; }
function reportDay(date) {
  const t = targets();
  const list = dayEntries(date);
  const tot = sum(list.map(entryNutr));
  const name = (state.profile && state.profile.name) || 'Клиент';
  const of = (v, key, unit) => `${fmt(v)}${t ? ' из ' + fmt(t[key]) : ''} ${unit}${pct(v, t && t[key])}`;
  const lines = [
    `Отчёт по питанию: ${name}`,
    longDate(date),
    '',
    `Калории: ${of(tot.k, 'k', 'ккал')}`,
    `Белки: ${of(tot.p, 'p', 'г')}`,
    `Жиры: ${of(tot.f, 'f', 'г')}`,
    `Углеводы: ${of(tot.c, 'c', 'г')}`,
    `Клетчатка: ${of(tot.fb, 'fb', 'г')}`
  ];
  if (!list.length) lines.push('', 'За этот день записей нет.');
  MEALS.forEach(m => {
    const items = list.filter(e => e.meal === m.id);
    if (!items.length) return;
    const mt = sum(items.map(entryNutr));
    lines.push('', `${m.name}, ${fmt(mt.k)} ккал`);
    items.forEach(e => {
      const n = entryNutr(e);
      lines.push(`• ${e.n}, ${fmt(e.grams)} г: ${fmt(n.k)} ккал, Б ${fmt(n.p)} / Ж ${fmt(n.f)} / У ${fmt(n.c)} / Кл ${fmt(n.fb)}`);
    });
  });
  return lines.join('\n');
}
function reportWeek(endDate) {
  const t = targets();
  const name = (state.profile && state.profile.name) || 'Клиент';
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(shiftDate(endDate, -i));
  const filled = days.filter(d => dayEntries(d).length);
  const lines = [`Отчёт по питанию за 7 дней: ${name}`, `${shortDate(days[0])} – ${shortDate(days[6])}`, ''];
  days.forEach(d => {
    if (!dayEntries(d).length) { lines.push(`${shortDate(d)}: нет записей`); return; }
    const x = dayTotals(d);
    lines.push(`${shortDate(d)}: ${fmt(x.k)} ккал, Б ${fmt(x.p)} / Ж ${fmt(x.f)} / У ${fmt(x.c)} / Кл ${fmt(x.fb)}`);
  });
  if (filled.length) {
    const avg = sum(filled.map(dayTotals));
    KEYS.forEach(k => { avg[k] /= filled.length; });
    const of = (v, key, unit) => `${fmt(v)}${t ? ' из ' + fmt(t[key]) : ''} ${unit}${pct(v, t && t[key])}`;
    lines.push('', `В среднем за ${filled.length} ${plural(filled.length, 'день', 'дня', 'дней')} с записями:`,
      `Калории: ${of(avg.k, 'k', 'ккал')}`, `Белки: ${of(avg.p, 'p', 'г')}`, `Жиры: ${of(avg.f, 'f', 'г')}`,
      `Углеводы: ${of(avg.c, 'c', 'г')}`, `Клетчатка: ${of(avg.fb, 'fb', 'г')}`);
  }
  return lines.join('\n');
}
function plural(n, a, b, c) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return a;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return b;
  return c;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove(); return ok;
  }
}

function reportView() {
  let mode = 'day';
  const v = {
    title: 'Отчёт тренеру',
    render(body) {
      const text = mode === 'day' ? reportDay(state.date) : reportWeek(state.date);
      const trainer = state.settings.trainer;
      const noName = !(state.profile && state.profile.name);
      body.innerHTML = `<div class="segmented two" role="group" aria-label="Период">
          <button data-m="day" aria-pressed="${mode === 'day'}">${state.date === isoDate(new Date()) ? 'Сегодня' : 'Этот день'}</button>
          <button data-m="week" aria-pressed="${mode === 'week'}">7 дней</button>
        </div>
        ${noName ? '<div class="no-norm" style="margin-top:12px"><span>Укажите имя, чтобы тренер понял, от кого отчёт</span><button class="btn btn-small btn-secondary" data-prof>Указать</button></div>' : ''}
        <div class="report-text">${esc(text)}</div>
        <div class="actions">
          <button class="btn btn-primary" data-tg>${trainer ? 'Отправить в Telegram @' + esc(trainer) : 'Отправить в Telegram'}</button>
          <div class="list-actions" style="margin:0">
            <button class="btn btn-secondary btn-small" data-share>Другим способом</button>
            <button class="btn btn-secondary btn-small" data-copy>Скопировать</button>
          </div>
        </div>
        ${trainer ? '' : '<p class="hint">Впишите Telegram тренера в профиле — кнопка будет сразу открывать его чат.</p>'}`;
      $$('[data-m]', body).forEach(b => b.addEventListener('click', () => { mode = b.dataset.m; v.render(body); }));
      const prof = $('[data-prof]', body);
      if (prof) prof.addEventListener('click', () => sheet.push(profileView()));
      $('[data-copy]', body).addEventListener('click', async () => toast(await copyText(text) ? 'Отчёт скопирован' : 'Не удалось скопировать'));
      $('[data-share]', body).addEventListener('click', async () => {
        if (navigator.share) {
          try { await navigator.share({ text }); } catch (e) { /* пользователь закрыл окно */ }
        } else {
          toast(await copyText(text) ? 'Отчёт скопирован — вставьте в чат' : 'Не удалось скопировать');
        }
      });
      $('[data-tg]', body).addEventListener('click', async () => {
        if (trainer) {
          await copyText(text);
          toast('Отчёт скопирован — вставьте его в чат');
          setTimeout(() => { location.href = `https://t.me/${encodeURIComponent(trainer)}`; }, 700);
        } else {
          location.href = `https://t.me/share/url?url=${encodeURIComponent(text)}`;
        }
      });
    }
  };
  return v;
}

/* ---------- События главного экрана ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t || sheet.isOpen()) return;
  const act = t.dataset.act;
  if (act === 'add') sheet.open(addView(t.dataset.meal));
  else if (act === 'profile') sheet.open(profileView());
  else if (act === 'edit') {
    const entry = dayEntries(state.date).find(x => x.id === t.dataset.id);
    if (!entry) return;
    const live = allFoods().find(f => f.n === entry.n);
    const food = { n: entry.n, g: '', ...entry.per, u: live ? live.u : (entry.unit && entry.unit[0] !== 'г' ? [entry.unit] : []), src: entry.src };
    sheet.open(amountView(food, { entry }));
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheet.isOpen()) { sheet.close(); return; }
  if (e.key === 'Enter' && !sheet.isOpen()) {
    const t = e.target.closest('.entry');
    if (t) t.click();
  }
});
$('#btnProfile').addEventListener('click', () => sheet.open(profileView()));
$('#btnReport').addEventListener('click', () => sheet.open(reportView()));
$('#dayPrev').addEventListener('click', () => { state.date = shiftDate(state.date, -1); renderMain(); });
$('#dayNext').addEventListener('click', () => { state.date = shiftDate(state.date, 1); renderMain(); });
$('#dayLabel').addEventListener('click', () => {
  const p = $('#dayPicker');
  p.value = state.date;
  if (p.showPicker) { try { p.showPicker(); return; } catch (e) { /* ниже запасной путь */ } }
  state.date = isoDate(new Date()); renderMain();
});
$('#dayPicker').addEventListener('change', e => { if (e.target.value) { state.date = e.target.value; renderMain(); } });
$('#sheetClose').addEventListener('click', () => sheet.close());
$('#sheetBack').addEventListener('click', () => sheet.back());
$('#backdrop').addEventListener('click', () => sheet.close());

// Новый день после полуночи, если приложение было открыто
let lastToday = isoDate(new Date());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = isoDate(new Date());
  if (now !== lastToday) { if (state.date === lastToday) state.date = now; lastToday = now; renderMain(); }
});

/* ---------- Старт ---------- */
renderMain();
loadDb();
if (!state.profile) setTimeout(() => { if (!sheet.isOpen()) sheet.open(profileView()); }, 400);
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
