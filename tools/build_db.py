"""Собирает data/parts/*.json в data/foods.json и проверяет цифры.

Запуск: python3 tools/build_db.py
Чтобы добавить продукты, допишите их в любой файл data/parts/ (формат в data/SPEC.md) и запустите скрипт.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARTS = ROOT / "data" / "parts"
OUT = ROOT / "data" / "foods.json"

GROUP_ORDER = [
    "Супы", "Вторые блюда", "Гарниры", "Блюда из теста и творога", "Салаты", "Фастфуд и уличная еда",
    "Крупы и каши", "Макароны", "Хлеб и выпечка", "Мука", "Бобовые", "Хлопья и мюсли",
    "Птица", "Мясо", "Колбасы и мясные изделия", "Мясные полуфабрикаты", "Рыба", "Морепродукты и консервы",
    "Молочные продукты", "Сыры", "Яйца", "Растительное молоко", "Спортивное питание",
    "Овощи и зелень", "Грибы", "Фрукты и ягоды", "Сухофрукты", "Орехи и семена",
    "Сладости и десерты", "Снеки", "Напитки", "Алкоголь", "Соусы и приправы", "Масла и жиры",
]


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-zа-я0-9%]+", " ", s.lower().replace("ё", "е"))).strip()


def main() -> int:
    items, seen, problems = [], {}, []
    for path in sorted(PARTS.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for i, it in enumerate(data):
            where = f"{path.name}#{i} «{it.get('n')}»"
            try:
                n = str(it["n"]).strip()
                g = str(it["g"]).strip()
                k, p, f, c = (float(it[x]) for x in ("k", "p", "f", "c"))
                fb = float(it.get("fb", 0) or 0)
                al = float(it.get("al", 0) or 0)
            except (KeyError, TypeError, ValueError) as e:
                problems.append(f"{where}: нет поля или не число ({e})")
                continue
            if min(k, p, f, c, fb, al) < 0 or p + f + c + fb > 100.5:
                problems.append(f"{where}: невозможные значения")
                continue
            calc = 4 * p + 9 * f + 4 * c + 2 * fb + 7 * al
            if k >= 20 and abs(calc - k) / k > 0.12:
                problems.append(f"{where}: ккал {k:g}, по БЖУ {calc:.0f}")
            elif k < 20 and abs(calc - k) > 6:
                problems.append(f"{where}: ккал {k:g}, по БЖУ {calc:.0f}")
            key = norm(n)
            if key in seen:
                problems.append(f"{where}: дубль, уже есть в {seen[key]}")
                continue
            seen[key] = path.name
            if g not in GROUP_ORDER:
                GROUP_ORDER.append(g)
            aliases = [a.strip() for a in it.get("a", []) if a and a.strip() and norm(a) != key]
            units = [[str(u[0]), round(float(u[1]), 1)] for u in it.get("u", []) if len(u) == 2 and float(u[1]) > 0]
            items.append([n, GROUP_ORDER.index(g), round(k), round(p, 1), round(f, 1), round(c, 1), round(fb, 1),
                          "|".join(aliases), units])
    items.sort(key=lambda r: (r[1], r[0]))
    used = sorted({r[1] for r in items})
    remap = {old: new for new, old in enumerate(used)}
    for r in items:
        r[1] = remap[r[1]]
    out = {"v": 1, "groups": [GROUP_ORDER[i] for i in used], "items": items}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Записей: {len(items)}, групп: {len(used)}, размер: {OUT.stat().st_size // 1024} КБ")
    for g in out["groups"]:
        print(f"  {g}: {sum(1 for r in items if out['groups'][r[1]] == g)}")
    if problems:
        print(f"\nЗамечания ({len(problems)}):")
        print("\n".join("  " + p for p in problems))
    return 0


if __name__ == "__main__":
    sys.exit(main())
