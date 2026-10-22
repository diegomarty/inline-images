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
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from art import GREEN, INK, MUTED, ORANGE, WINDOW, chip, glow, gradient, mono, photo, place, rounded_mask

OUT = sys.argv[1]
S = 2048  # drawn at twice the size, then shrunk: smooth edges
FINAL = 1024
random.seed(7)
ROUND = 450

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
