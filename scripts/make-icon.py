"""Draws the Inline Images icon.

A fan of three photos (the frames of a GIF) over a night-violet ground. The front one is a
synthwave sunset that, on its left, is drawn as a terminal draws a picture in text: tall cells, each
split in two colors by a half block; a glowing seam runs where the cells give way to the picture
itself. Under the photos, a prompt bar of glass: the chevron, the chip the mod draws for a picture,
the cursor.

    python3 scripts/make-icon.py .claude-plugin/icon.png   (needs Pillow)
"""
import math
import random
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = sys.argv[1]
S = 2048  # drawn at twice the size, then shrunk: smooth edges
FINAL = 1024
random.seed(7)

INK = (250, 246, 255)
ORANGE = (255, 150, 90)
PINK = (255, 90, 170)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(size, stops):
    """A vertical gradient through `stops` [(t, color)], top to bottom."""
    w, h = size
    line = Image.new('RGB', (1, 1024))
    for i in range(1024):
        t = i / 1023
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                line.putpixel((0, i), lerp(c0, c1, (t - t0) / max(1e-6, t1 - t0)))
                break
    return line.resize((1, h)).resize((w, h))


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return m


def glow(size, center, radius, color, alpha):
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    cx, cy = center
    ImageDraw.Draw(layer).ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.45))


def scene(w, h, sink=0.0, stars=True):
    """A synthwave sunset, the sun `sink` lower for each later frame."""
    img = gradient((w, h), [(0, (30, 18, 74)), (0.40, (196, 58, 140)), (0.64, (255, 144, 92)), (1, (255, 196, 120))]).convert('RGBA')
    d = ImageDraw.Draw(img)
    if stars:
        for _ in range(26):
            x, y = random.uniform(0, w), random.uniform(0, h * 0.30)
            r = random.choice([2, 3, 3, 4, 5]) * w / 1200
            d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 240, 255, random.randint(120, 230)))
    r = w * 0.235
    cx, cy = w * 0.60, h * (0.52 + sink)
    img = Image.alpha_composite(img, glow((w, h), (cx, cy), r * 1.55, (255, 170, 120), 150))
    # The sun, striped across its lower half.
    sun = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sun)
    for y in range(int(cy - r), int(cy + r)):
        half = math.sqrt(max(0, r * r - (y - cy) ** 2))
        sd.line([(cx - half, y), (cx + half, y)], fill=lerp((255, 236, 130), (255, 92, 128), (y - (cy - r)) / (2 * r)) + (255,))
    for k in range(5):
        y = cy + r * (0.10 + k * 0.17)
        sd.rectangle((0, y, w, y + r * (0.025 + k * 0.022)), fill=(0, 0, 0, 0))
    img = Image.alpha_composite(img, sun)
    d = ImageDraw.Draw(img)
    # Two ridges, the far one lit on its sunward slopes.
    far = [(-20, h * 0.80), (w * 0.17, h * 0.53), (w * 0.33, h * 0.67), (w * 0.50, h * 0.48), (w * 0.77, h * 0.73), (w * 0.94, h * 0.59), (w + 20, h * 0.67), (w + 20, h), (-20, h)]
    d.polygon(far, fill=(96, 40, 124))
    for (x0, y0), (x1, y1) in [((w * 0.50, h * 0.48), (w * 0.62, h * 0.60)), ((w * 0.17, h * 0.53), (w * 0.24, h * 0.59))]:
        d.polygon([(x0, y0), (x1, y1), (x0 - w * 0.02, y1 + h * 0.06)], fill=(140, 62, 150))
    d.polygon([(-20, h * 0.86), (w * 0.26, h * 0.69), (w * 0.46, h * 0.82), (w * 0.70, h * 0.65), (w + 20, h * 0.84), (w + 20, h), (-20, h)], fill=(48, 22, 80))
    # The ground: a neon grid to the horizon, the sun's light on it.
    gy = h * 0.875
    d.rectangle((0, gy, w, h), fill=(28, 14, 54))
    img = Image.alpha_composite(img, glow((w, h), (cx, gy + h * 0.02), w * 0.16, (255, 120, 160), 110))
    d = ImageDraw.Draw(img)
    lw = max(2, w // 240)
    for i in range(-9, 10):
        d.line([(w / 2 + i * w * 0.018, gy), (w / 2 + i * w * 0.15, h)], fill=PINK, width=lw)
    for k in range(5):
        y = gy + (h - gy) * (k / 5) ** 1.7
        d.line([(0, y), (w, y)], fill=PINK, width=lw)
    d.line([(0, gy), (w, gy)], fill=(255, 200, 220), width=lw)
    return img


def terminal_cells(img, columns):
    """The picture as a terminal draws it in text: cells twice as tall as wide, each split by a half
    block into an upper and a lower color; a hairline between cells, none between their halves."""
    cw = img.width // columns
    ch = cw * 2
    rows = math.ceil(img.height / ch)
    halves = img.resize((columns, rows * 2), Image.BOX)
    out = halves.resize((columns * cw, rows * ch), Image.NEAREST).crop((0, 0, img.width, img.height))
    full = img.copy()
    full.paste(out, (0, 0))
    d = ImageDraw.Draw(full)
    for x in range(0, img.width, cw):
        d.line([(x, 0), (x, img.height)], fill=(24, 10, 46, 110), width=3)
    for y in range(0, img.height, ch):
        d.line([(0, y), (img.width, y)], fill=(24, 10, 46, 110), width=3)
    return full, cw, ch


def photo(w, h, sink, front):
    """A photo in a white frame; the front one drawn in cells on its left, a seam of light between."""
    pic = scene(w, h, sink, stars=front)
    if front:
        cells, cw, ch = terminal_cells(pic, 16)
        mask = Image.new('L', (w, h), 0)
        md = ImageDraw.Draw(mask)
        for y in range(0, h, ch):
            for x in range(0, w, cw):
                if x + y * 0.62 < w * 0.50:
                    md.rectangle((x, y, x + cw - 1, y + ch - 1), fill=255)
        pic = Image.composite(cells, pic, mask)
        # The seam: the mask's edge, glowing.
        edge = ImageChops.subtract(mask.filter(ImageFilter.MaxFilter(9)), mask)
        seam = Image.new('RGBA', (w, h), (255, 220, 240, 0))
        seam.putalpha(edge.filter(ImageFilter.GaussianBlur(10)).point(lambda a: min(255, a * 3)))
        pic = Image.alpha_composite(pic, seam)
        line = Image.new('RGBA', (w, h), (255, 245, 250, 0))
        line.putalpha(edge.point(lambda a: 230 if a > 0 else 0))
        pic = Image.alpha_composite(pic, line)
    border = int(w * 0.034)
    framed = Image.new('RGBA', (w + 2 * border, h + 2 * border), (0, 0, 0, 0))
    radius = int(w * 0.07)
    # The frame: white, a touch warmer at its foot.
    frame = gradient(framed.size, [(0, (255, 252, 255)), (1, (236, 226, 246))]).convert('RGBA')
    framed.paste(frame, (0, 0), rounded_mask(framed.size, radius))
    framed.paste(pic, (border, border), rounded_mask((w, h), int(radius * 0.6)))
    # A hairline inside the frame, where the picture sits in it.
    ImageDraw.Draw(framed).rounded_rectangle((border - 2, border - 2, border + w + 1, border + h + 1), int(radius * 0.6) + 2, outline=(200, 180, 220, 160), width=3)
    if not front:
        dim = Image.new('RGBA', framed.size, (60, 30, 100, 34))
        framed = Image.composite(Image.alpha_composite(framed, dim), framed, framed.split()[3])
    return framed


def place(base, card, center, angle):
    rotated = card.rotate(angle, resample=Image.BICUBIC, expand=True)
    x = int(center[0] - rotated.width / 2)
    y = int(center[1] - rotated.height / 2)
    shadow = Image.new('RGBA', base.size, (0, 0, 0, 0))
    shadow.paste((10, 4, 24, 255), (x + 14, y + 50), rotated.split()[3].point(lambda a: int(a * 0.6)))
    base = Image.alpha_composite(base, shadow.filter(ImageFilter.GaussianBlur(42)))
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    layer.paste(rotated, (x, y), rotated)
    return Image.alpha_composite(base, layer)


ROUND = 450
icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# The ground: night violet, a warm glow behind the photos, a vignette at the corners, a little grain.
ground = gradient((S, S), [(0, (46, 26, 96)), (0.55, (25, 16, 56)), (1, (12, 9, 28))]).convert('RGBA')
ground = Image.alpha_composite(ground, glow((S, S), (S * 0.50, S * 0.45), S * 0.44, (255, 90, 150), 115))
ground = Image.alpha_composite(ground, glow((S, S), (S * 0.62, S * 0.34), S * 0.22, (255, 170, 90), 80))
grain = Image.effect_noise((S, S), 22).convert('L').point(lambda v: max(0, v - 118))
ground = Image.alpha_composite(ground, Image.merge('RGBA', (grain, grain, grain, grain.point(lambda v: v // 3))))
# A rim of light along the square's top edge.
rim = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle((6, 6, S - 7, S - 7), ROUND - 6, outline=(255, 210, 240, 70), width=6)
rim_fade = gradient((S, S), [(0, (255, 255, 255)), (0.35, (0, 0, 0)), (1, (0, 0, 0))]).convert('L')
rim.putalpha(ImageChops.multiply(rim.split()[3], rim_fade))
ground = Image.alpha_composite(ground, rim)
icon.paste(ground, (0, 0), rounded_mask((S, S), ROUND))

# Three photos fanned out: the frames of a GIF, the sun lower in each.
pw, ph = int(S * 0.62), int(S * 0.45)
canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
canvas = place(canvas, photo(pw, ph, 0.16, False), (S * 0.425, S * 0.395), 12)
canvas = place(canvas, photo(pw, ph, 0.08, False), (S * 0.455, S * 0.42), 5.5)
canvas = place(canvas, photo(pw, ph, 0.0, True), (S * 0.50, S * 0.45), -3.5)
clip = rounded_mask((S, S), ROUND)
icon = Image.alpha_composite(icon, Image.composite(canvas, Image.new('RGBA', (S, S), (0, 0, 0, 0)), clip))

# The prompt bar: glass, its chevron, the chip of a picture, the cursor.
bh = int(S * 0.13)
bw = int(bh * 3.85)
bar = (int(S * 0.5 - bw / 2), int(S * 0.76), int(S * 0.5 + bw / 2), int(S * 0.76) + bh)
blurred = icon.crop(bar).filter(ImageFilter.GaussianBlur(30))
glass = Image.alpha_composite(blurred, Image.new('RGBA', blurred.size, (255, 255, 255, 26)))
icon.paste(glass, bar[:2], rounded_mask(glass.size, bh // 2))
d = ImageDraw.Draw(icon)
d.rounded_rectangle(bar, bh // 2, outline=(255, 235, 250, 70), width=5)
cy = (bar[1] + bar[3]) / 2
px = bar[0] + bh * 0.50
k = bh * 0.20
d.line([(px, cy - k), (px + k * 1.1, cy), (px, cy + k)], fill=ORANGE, width=int(bh * 0.10), joint='curve')
for x, y in [(px, cy - k), (px + k * 1.1, cy), (px, cy + k)]:
    rr = bh * 0.05
    d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=ORANGE)
# The chip: orange, a small picture in it, as the mod draws the one the pointer is on.
chip = (px + bh * 0.62, cy - bh * 0.25, px + bh * 0.62 + bh * 1.55, cy + bh * 0.25)
d.rounded_rectangle(chip, bh * 0.12, fill=ORANGE)
gx0, gy0 = chip[0] + bh * 0.16, chip[1] + bh * 0.11
gx1, gy1 = gx0 + bh * 0.40, chip[3] - bh * 0.11
d.rounded_rectangle((gx0, gy0, gx1, gy1), bh * 0.04, outline=(54, 22, 70), width=int(bh * 0.045))
d.polygon([(gx0 + bh * 0.04, gy1 - bh * 0.04), (gx0 + bh * 0.15, gy0 + bh * 0.12), (gx0 + bh * 0.24, gy1 - bh * 0.06), (gx0 + bh * 0.29, gy0 + bh * 0.17), (gx1 - bh * 0.03, gy1 - bh * 0.04)], fill=(54, 22, 70))
for i, length in enumerate([0.62, 0.42]):
    ty = cy - bh * 0.07 + i * bh * 0.14
    d.rounded_rectangle((gx1 + bh * 0.12, ty - bh * 0.035, gx1 + bh * 0.12 + bh * length, ty + bh * 0.035), bh * 0.035, fill=(54, 22, 70))
# The cursor.
cx = chip[2] + bh * 0.28
d.rounded_rectangle((cx, cy - bh * 0.27, cx + bh * 0.22, cy + bh * 0.27), bh * 0.04, fill=INK)

icon.resize((FINAL, FINAL), Image.LANCZOS).save(OUT, optimize=True)
