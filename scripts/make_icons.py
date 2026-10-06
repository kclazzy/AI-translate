"""Draw the app icon (speech bubble with あ→Я) at several sizes. Run: python scripts/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
MAGENTA, INK, PAPER = (200, 32, 95), (28, 34, 48), (255, 255, 255)


def font(paths, size):
    for p in paths:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def draw(size=1024):
    s = size
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=MAGENTA)
    # bubble
    bx0, by0, bx1, by1 = int(s * 0.14), int(s * 0.16), int(s * 0.86), int(s * 0.72)
    lw = max(2, int(s * 0.035))
    d.polygon([(int(s * 0.30), int(s * 0.66)), (int(s * 0.22), int(s * 0.88)), (int(s * 0.46), int(s * 0.70))], fill=PAPER, outline=INK)
    d.ellipse([bx0, by0, bx1, by1], fill=PAPER, outline=INK, width=lw)
    d.polygon([(int(s * 0.31), int(s * 0.64)), (int(s * 0.25), int(s * 0.82)), (int(s * 0.44), int(s * 0.66))], fill=PAPER)
    d.line([(int(s * 0.30), int(s * 0.67)), (int(s * 0.22), int(s * 0.88)), (int(s * 0.46), int(s * 0.705))], fill=INK, width=lw, joint="curve")
    jp = font(["/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"], int(s * 0.26))
    ru = font(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"], int(s * 0.30))
    d.text((int(s * 0.33), int(s * 0.44)), "あ", font=jp, fill=INK, anchor="mm")
    d.text((int(s * 0.66), int(s * 0.44)), "Я", font=ru, fill=MAGENTA, anchor="mm")
    return im


def main():
    big = draw(1024)
    out = ROOT / "apps/extension/public/icons"
    out.mkdir(parents=True, exist_ok=True)
    for n in (16, 32, 48, 128):
        big.resize((n, n), Image.LANCZOS).save(out / f"{n}.png")
    mob = ROOT / "apps/mobile/public/icons"
    mob.mkdir(parents=True, exist_ok=True)
    for n in (192, 512):
        big.resize((n, n), Image.LANCZOS).save(mob / f"icon-{n}.png")
    # Maskable icon: full-bleed background, content in the safe zone.
    m = Image.new("RGBA", (512, 512), MAGENTA)
    m.alpha_composite(big.resize((380, 380), Image.LANCZOS), (66, 66))
    m.save(mob / "maskable-512.png")
    big.resize((180, 180), Image.LANCZOS).save(mob / "apple-touch-icon.png")
    big.save(ROOT / "apps/mobile/resources-icon.png")
    print("icons written")


if __name__ == "__main__":
    main()
