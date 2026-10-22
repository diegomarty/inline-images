"""Draws the Inline Images icon.

A terminal window holding a Claude Code transcript: a `● Read(sunset.gif)` row, under its `⎿` the
orange chip the mod draws for a picture, and the picture: a synthwave sunset that, on its left, is
drawn as a terminal draws a picture in text (tall cells, each split in two colors by a half block),
a glowing seam where the cells give way to the picture itself. At the foot, the prompt box.

    python3 scripts/make-icon.py .claude-plugin/icon.png   (needs Pillow)
"""
import math
import random
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

OUT = sys.argv[1]
S = 2048  # drawn at twice the size, then shrunk: smooth edges
FINAL = 1024
random.seed(7)

INK = (250, 246, 255)
ORANGE = (255, 150, 90)
PINK = (255, 90, 170)
GREEN = (98, 210, 130)
MUTED = (150, 132, 180)
WINDOW = (22, 15, 40)


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


def mono(size):
    """A monospaced font: Menlo on macOS, DejaVu Sans Mono elsewhere; Pillow's own past both."""
    for path in ['/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default(size)


icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# The ground: night violet, a warm glow behind the window, a little grain, a rim of light on top.
ground = gradient((S, S), [(0, (46, 26, 96)), (0.55, (25, 16, 56)), (1, (12, 9, 28))]).convert('RGBA')
ground = Image.alpha_composite(ground, glow((S, S), (S * 0.50, S * 0.46), S * 0.46, (255, 90, 150), 105))
ground = Image.alpha_composite(ground, glow((S, S), (S * 0.62, S * 0.36), S * 0.22, (255, 170, 90), 70))
grain = Image.effect_noise((S, S), 22).convert('L').point(lambda v: max(0, v - 118))
ground = Image.alpha_composite(ground, Image.merge('RGBA', (grain, grain, grain, grain.point(lambda v: v // 3))))
rim = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle((6, 6, S - 7, S - 7), ROUND - 6, outline=(255, 210, 240, 70), width=6)
rim.putalpha(ImageChops.multiply(rim.split()[3], gradient((S, S), [(0, (255, 255, 255)), (0.35, (0, 0, 0)), (1, (0, 0, 0))]).convert('L')))
ground = Image.alpha_composite(ground, rim)
icon.paste(ground, (0, 0), rounded_mask((S, S), ROUND))

# The terminal window: dark, a shadow under it, a thin title bar.
win = (int(S * 0.095), int(S * 0.115), int(S * 0.905), int(S * 0.885))
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((win[0], win[1] + 50, win[2], win[3] + 50), 130, fill=(6, 3, 16, 190))
icon = Image.alpha_composite(icon, shadow.filter(ImageFilter.GaussianBlur(55)))
body = gradient((win[2] - win[0], win[3] - win[1]), [(0, (30, 20, 54)), (1, WINDOW)]).convert('RGBA')
icon.paste(body, win[:2], rounded_mask(body.size, 130))
d = ImageDraw.Draw(icon)
d.rounded_rectangle(win, 130, outline=(120, 96, 168), width=6)
for i in range(3):
    cx, cy, r = win[0] + 110 + i * 66, win[1] + 80, 18
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(84, 66, 120))

# The transcript: the Read call's row, as Claude Code draws it.
font = mono(int(S * 0.040))
tx, ty = win[0] + 100, win[1] + 165
d.text((tx, ty), '●', font=font, fill=GREEN, anchor='lm')
step = d.textlength('● ', font=font)
d.text((tx + step, ty), 'Read', font=font, fill=INK, anchor='lm')
d.text((tx + step + d.textlength('Read', font=font), ty), '(sunset.gif)', font=font, fill=MUTED, anchor='lm')


def chip(d, x, cy, h):
    """The chip the mod draws for a picture an answer names: orange, a small picture and a name in
    it. `x` its left edge, `cy` its middle, `h` its height; answers its right edge."""
    w = h * 3.1
    d.rounded_rectangle((x, cy - h / 2, x + w, cy + h / 2), h * 0.22, fill=ORANGE)
    ink = (54, 22, 70)
    gx0, gy0 = x + h * 0.30, cy - h * 0.29
    gx1, gy1 = gx0 + h * 0.80, cy + h * 0.29
    d.rounded_rectangle((gx0, gy0, gx1, gy1), h * 0.08, outline=ink, width=int(h * 0.09))
    d.polygon([(gx0 + h * 0.08, gy1 - h * 0.08), (gx0 + h * 0.30, gy0 + h * 0.22), (gx0 + h * 0.48, gy1 - h * 0.13),
               (gx0 + h * 0.58, gy0 + h * 0.33), (gx1 - h * 0.06, gy1 - h * 0.08)], fill=ink)
    for i, length in enumerate([1.25, 0.85]):
        yy = cy - h * 0.14 + i * h * 0.28
        d.rounded_rectangle((gx1 + h * 0.24, yy - h * 0.07, gx1 + h * 0.24 + h * length, yy + h * 0.07), h * 0.07, fill=ink)
    return x + w


# Under the row, after its ⎿, the chip the mod draws for the picture: what the icon is about.
chip_h = S * 0.072
chip_cy = ty + S * 0.085
hook_x = tx + step * 0.55
d.line([(hook_x, ty + S * 0.03), (hook_x, chip_cy), (hook_x + S * 0.03, chip_cy)], fill=MUTED, width=7)
chip(d, hook_x + S * 0.045, chip_cy, chip_h)

# The picture: one photo, the sunset that turns from cells into itself, centered across the window
# and down the room between the chip and the prompt box, as large as that room holds (up to PHOTO
# of the square), so it stands as far from one as from the other.
PHOTO = 0.60
GAP = S * 0.04  # the same above and below the photo
box_top = int(win[3] - S * 0.125)
area = (chip_cy + chip_h / 2 + GAP, box_top - GAP)
ANGLE = 0


def extent(card, angle):
    a = math.radians(angle)
    return (card.width * abs(math.cos(a)) + card.height * abs(math.sin(a)), card.width * abs(math.sin(a)) + card.height * abs(math.cos(a)))


pw = int(S * PHOTO)
while True:
    card = photo(pw, int(pw * 0.72), 0.0, True)
    rw, rh = extent(card, ANGLE)
    if rh <= area[1] - area[0] and rw <= (win[2] - win[0]) - S * 0.14:
        break
    pw -= int(S * 0.01)
canvas = place(Image.new('RGBA', (S, S), (0, 0, 0, 0)), card, (S / 2, (area[0] + area[1]) / 2), ANGLE)
icon = Image.alpha_composite(icon, Image.composite(canvas, Image.new('RGBA', (S, S), (0, 0, 0, 0)), rounded_mask((S, S), ROUND)))

# The prompt box, as Claude Code draws it: rounded, its chevron, the cursor.
d = ImageDraw.Draw(icon)
box = (win[0] + 70, box_top, win[2] - 70, win[3] - 70)
bh = box[3] - box[1]
d.rounded_rectangle(box, 34, fill=(30, 20, 52), outline=(150, 120, 190), width=6)
cy = (box[1] + box[3]) / 2
px = box[0] + bh * 0.45
k = bh * 0.18
d.line([(px, cy - k), (px + k * 1.1, cy), (px, cy + k)], fill=ORANGE, width=int(bh * 0.10), joint='curve')
for x, y in [(px, cy - k), (px + k * 1.1, cy), (px, cy + k)]:
    rr = bh * 0.05
    d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=ORANGE)
cx = px + bh * 0.62
d.rectangle((cx, cy - bh * 0.26, cx + bh * 0.20, cy + bh * 0.26), fill=INK)

icon.resize((FINAL, FINAL), Image.LANCZOS).save(OUT, optimize=True)
