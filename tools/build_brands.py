"""Собирает data/brands.json — магазинные продукты со штрихкодами из выгрузки Open Food Facts.

Запуск: python3 tools/build_brands.py путь/к/off_ru.tsv
TSV получается фильтром выгрузки https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz
(российские и белорусские штрихкоды, русские названия, страна Россия или Беларусь, есть КБЖУ).

Данные Open Food Facts распространяются по лицензии ODbL: https://opendatacommons.org/licenses/odbl/1-0/
"""
import csv
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "brands.json"
CYR = re.compile(r"[а-яА-ЯёЁ]")
RU_ONLY = re.compile(r"[ыэёЫЭЁ]")
UA_BG = re.compile(r"[іїєґІЇЄҐјљњћђџ]|\b(сос|краве|сирене|бисквити|кисело|мляко|хляб)\b", re.I)
RU_CODE = ("460", "461", "462", "463", "464", "465", "466", "467", "468", "469", "481", "487")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-zа-я0-9%]+", " ", s.lower().replace("ё", "е"))).strip()


BASE_NAMES = {norm(r[0]) for r in json.loads((ROOT / "data" / "foods.json").read_text(encoding="utf-8"))["items"]}


def num(s):
    try:
        v = float(s)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def ean_ok(code: str) -> bool:
    if not code.isdigit() or len(code) not in (8, 12, 13):
        return False
    c = code.zfill(13) if len(code) == 12 else code
    digits = [int(d) for d in c]
    if len(c) == 13:
        s = sum(d * (3 if i % 2 else 1) for i, d in enumerate(digits[:12]))
    else:
        s = sum(d * (1 if i % 2 else 3) for i, d in enumerate(digits[:7]))
    return (10 - s % 10) % 10 == digits[-1]


def clean_name(s: str) -> str:
    s = html.unescape(html.unescape(s)).replace("\\", "").strip(" \"'«»,.-")
    s = re.sub(r"\s+", " ", s)
    if s and s[0].islower():
        s = s[0].upper() + s[1:]
    if s.isupper() and len(s) > 4:
        s = s[0] + s[1:].lower()
    return s


def main(path: str) -> int:
    rows = csv.DictReader(open(path, encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE)
    best = {}
    stats = {"всего": 0, "битый штрихкод": 0, "нет названия": 0, "не русский язык": 0, "невозможные цифры": 0, "ккал не сходятся с БЖУ": 0}
    for r in rows:
        stats["всего"] += 1
        code = (r["code"] or "").strip().lstrip("0") or ""
        raw_code = (r["code"] or "").strip()
        if not ean_ok(raw_code):
            stats["битый штрихкод"] += 1
            continue
        name = clean_name(r["product_name"] or "")
        brand = clean_name((r["brands"] or "").split(",")[0])
        if len(name) < 3:
            stats["нет названия"] += 1
            continue
        if sum(ch.isdigit() for ch in name) > len(name) / 2:
            stats["нет названия"] += 1
            continue
        ru_code = raw_code.zfill(13)[:3] in RU_CODE
        tags = r["countries_tags"] or ""
        ru_tag = any(t in tags for t in ("en:russia", "en:belarus", "en:kazakhstan"))
        if UA_BG.search(name):
            stats["не русский язык"] += 1
            continue
        if CYR.search(name):
            # кириллица бывает болгарской и сербской: без российского штрихкода или метки страны нужны чисто русские буквы
            if not (ru_code or ru_tag or RU_ONLY.search(name)):
                stats["не русский язык"] += 1
                continue
        elif not ru_code:
            stats["не русский язык"] += 1
            continue
        k = num(r["energy-kcal_100g"])
        if k is None and num(r["energy_100g"]) is not None:
            k = num(r["energy_100g"]) / 4.184
        p, f, c = num(r["proteins_100g"]), num(r["fat_100g"]), num(r["carbohydrates_100g"])
        fb = num(r["fiber_100g"]) or 0.0
        if None in (k, p, f, c) or min(k, p, f, c, fb) < 0 or k > 902 or p + f + c + fb > 105 or (fb > c + 0.1 and fb > 30):
            stats["невозможные цифры"] += 1
            continue
        calc = 4 * p + 9 * f + 4 * c + 2 * fb
        # Этанол, сахарные спирты и округления на упаковке дают разброс — допускаем 20% или 15 ккал
        if abs(calc - k) > max(15, 0.2 * k):
            stats["ккал не сходятся с БЖУ"] += 1
            continue
        full = name if not brand or brand.lower() in name.lower() else f"{name} ({brand})"
        full = full[:90]
        units = []
        sq = num(r["serving_quantity"])
        if sq and 0 < sq < 2000:
            units.append(["порция", round(sq, 1)])
        pq = num(r["product_quantity"])
        if pq and 0 < pq < 5000 and (not units or abs(pq - units[0][1]) > 1):
            units.append(["упаковка", round(pq)])
        scans = int(num(r["unique_scans_n"]) or 0)
        # 10-й элемент: 1 — не показывать в текстовом поиске (безымянные «Майонез», «Йогурт»), но находить по штрихкоду
        generic = not brand and (norm(name) in BASE_NAMES or len(norm(re.sub(r"[\d%.,]+", " ", name)).split()) <= 1)
        item = [full, round(k), round(p, 1), round(f, 1), round(c, 1), round(fb, 1), raw_code, units, scans, 1 if generic else 0]
        key = code
        if key in best and best[key][8] >= scans:
            continue
        best[key] = item
    # Одинаковые названия под разными штрихкодами: в поиске показываем самый популярный, остальные — только сканеру
    items = sorted(best.values(), key=lambda it: (-it[8], it[0]))
    seen = set()
    for it in items:
        nk = norm(it[0])
        if nk in seen:
            it[9] = 1
        seen.add(nk)
    out = {"v": 1, "source": "Open Food Facts, ODbL", "items": items}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Записей: {len(items)}, из них в поиске {sum(1 for it in items if not it[9])}, размер: {OUT.stat().st_size // 1024} КБ")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
