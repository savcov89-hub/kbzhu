"""Иконки приложения: красный блин 25 кг, он же тарелка. Запуск: python3 tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)

GRAPHITE = (22, 26, 34)
RED = (214, 40, 57)
RED_DARK = (170, 26, 42)
CHALK = (237, 239, 242)


def plate(size: int, pad_ratio: float) -> Image.Image:
    s = 1024
    img = Image.new("RGB", (s, s), GRAPHITE)
    d = ImageDraw.Draw(img)
    c = s / 2
    r = s / 2 - s * pad_ratio
    d.ellipse([c - r, c - r, c + r, c + r], fill=RED)
    # обод блина
    r2 = r * 0.80
    d.ellipse([c - r2, c - r2, c + r2, c + r2], fill=RED_DARK)
    r3 = r * 0.76
    d.ellipse([c - r3, c - r3, c + r3, c + r3], fill=RED)
    # втулка
    r4 = r * 0.24
    d.ellipse([c - r4, c - r4, c + r4, c + r4], fill=CHALK)
    r5 = r * 0.11
    d.ellipse([c - r5, c - r5, c + r5, c + r5], fill=GRAPHITE)
    return img.resize((size, size), Image.LANCZOS)


for size in (180, 192, 512):
    plate(size, 0.08).save(OUT / f"icon-{size}.png", optimize=True)
plate(512, 0.17).save(OUT / "icon-maskable-512.png", optimize=True)
print("ok")
