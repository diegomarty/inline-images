"""Draws the README's pictures, illustrations of what the mod does, in the icon's palette:

- docs/demo.gif: a Claude Code transcript where Claude reads a GIF, the GIF playing under its row;
- docs/chips.png: an answer that names pictures, a chip beside each, the card of the one under the
  pointer open over the rows above;
- docs/pixels-and-cells.png: one picture as Ghostty and kitty draw it, and in cells, as any other
  terminal with true color does.

    python3 scripts/make-readme-images.py docs   (needs Pillow)
"""
import math
import os
import random
import sys
from PIL import Image, ImageDraw, ImageFilter

from art import GREEN, INK, MUTED, ORANGE, WINDOW, gradient, mono, rounded_mask, scene

OUT = sys.argv[1]
X = 2  # drawn at twice the size, then shrunk: smooth edges and text
FONT = mono(15 * X)
SMALL = mono(13 * X)
LINE = 25 * X
CELL = FONT.getlength('M')
PAGE = (20, 13, 36)
USER_BAND = (46, 34, 70)
DARK_INK = (54, 22, 70)


def sunset(w, h, sink=0.0):
    """The scene, its stars the same in every frame."""
    random.seed(3)
    return scene(w, h, sink).convert('RGB')


def window(w, h, title):
    """A terminal window on the page: its rounded body, a title bar, the title. Answers the image, a
    drawer on it, and where its text starts."""
    img = Image.new('RGBA', (w, h), PAGE + (0,))
    img.paste(gradient((w, h), [(0, (32, 22, 56)), (1, WINDOW)]), (0, 0), rounded_mask((w, h), 16 * X))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 16 * X, outline=(92, 72, 132), width=X)
    for i, color in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx, cy, r = 22 * X + i * 20 * X, 20 * X, 6 * X
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    d.text((w / 2, 20 * X), title, font=SMALL, fill=MUTED, anchor='mm')
    d.line([(0, 40 * X), (w, 40 * X)], fill=(52, 40, 80), width=X)
    return img, d, (24 * X, 56 * X)


def text(d, x, y, parts):
    """A line of `(text, color)` parts from `x`, its middle at `y`. Answers where it ends."""
    for part, color in parts:
        d.text((x, y), part, font=FONT, fill=color, anchor='lm')
        x += d.textlength(part, font=FONT)
    return x


def result(d, x, y, words):
    """A result row under a call, `  ⎿  words`, its hook drawn with lines (Menlo has no ⎿)."""
    hx = x + CELL * 2.5
    d.line([(hx, y - LINE * 0.42), (hx, y), (hx + CELL * 1.1, y)], fill=MUTED, width=X)
    return text(d, x + CELL * 5, y, [(words, MUTED)])


def user_row(img, d, x, y, prompt):
    """A prompt you sent, on its band, as Claude Code draws it."""
    d.rectangle((x - 10 * X, y - LINE / 2, img.width - 14 * X, y + LINE / 2), fill=USER_BAND)
    text(d, x, y, [('❯ ', MUTED), (prompt, INK)])


def prompt_box(img, d, x, y, w, cursor=True):
    """The prompt box at the foot: rounded, its chevron, the cursor."""
    h = 40 * X
    d.rounded_rectangle((x, y, x + w, y + h), 8 * X, outline=(110, 92, 150), width=X)
    text(d, x + 14 * X, y + h / 2, [('❯ ', ORANGE)])
    if cursor:
        cx = x + 14 * X + CELL * 2
        d.rectangle((cx, y + h / 2 - 9 * X, cx + CELL * 0.9, y + h / 2 + 9 * X), fill=INK)


def finish(img):
    return img.resize((img.width // X, img.height // X), Image.LANCZOS)


# --- docs/demo.gif: Claude reads a GIF; it plays under the row.
def demo():
    W, H = 900 * X, 520 * X
    pw, ph = 384 * X, 216 * X
    frames = []
    count = 24
    for i in range(count):
        img, d, (x, y) = window(W, H, '~/sunset — claude')
        user_row(img, d, x, y, 'what is in docs/media/sunset.gif?')
        y += LINE * 2
        text(d, x, y, [('● ', GREEN), ('Read', INK), ('(docs/media/sunset.gif)', MUTED)])
        y += LINE
        result(d, x, y, 'Read image (152KB)')
        y += LINE * 0.75
        # The picture, under the row where its text starts, the sun sinking and rising again.
        sink = 0.07 + 0.11 * math.sin(2 * math.pi * i / count)
        img.paste(sunset(pw, ph, sink), (int(x + CELL * 5), int(y)))
        y += ph + LINE * 1.0
        text(d, x, y, [('● ', INK), ('A synthwave sunset: the sun sinks behind violet mountains,', INK)])
        y += LINE
        text(d, x, y, [('  over a neon grid that runs to the horizon.', INK)])
        prompt_box(img, d, x - 6 * X, H - 60 * X, W - 2 * x + 12 * X, cursor=i % 8 < 4)
        frames.append(finish(img))
    # One palette for every frame, so only the picture changes from one to the next; it holds the
    # window's few strong colors (the dots, the bullet, the chevron) and the corners' see-through one.
    keep = [PAGE, GREEN, ORANGE, INK, MUTED, (255, 95, 87), (254, 188, 46), (40, 200, 64)]
    sample = frames[len(frames) // 4].convert('RGB')
    source = Image.new('RGB', (sample.width, sample.height + 64))
    source.paste(sample, (0, 0))
    swatch = sample.width // len(keep)
    for i, color in enumerate(keep):
        source.paste(color, (i * swatch, sample.height, (i + 1) * swatch, sample.height + 64))
    palette = source.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    clear = 255
    entries = palette.getpalette()[:255 * 3] + list(PAGE)
    palette.putpalette(entries)
    out = []
    for frame in frames:
        q = frame.convert('RGB').quantize(palette=palette, dither=Image.Dither.NONE)
        q.paste(clear, (0, 0), Image.eval(frame.split()[3], lambda a: 255 if a < 128 else 0))
        out.append(q)
    out[0].save(os.path.join(OUT, 'demo.gif'), save_all=True, append_images=out[1:], duration=90, loop=0, optimize=False, disposal=1, transparency=clear)


# --- docs/chips.png: the chips beside an answer, the card of the hovered one open.
HOVERED = 1


def chips():
    W, H = 900 * X, 520 * X
    img, d, (x, y) = window(W, H, '~/site — claude')
    user_row(img, d, x, y, 'which pictures does the README use?')
    y += LINE * 2
    text(d, x, y, [('● ', GREEN), ('Search', INK), ('(pattern: "docs/media/*")', MUTED)])
    y += LINE
    result(d, x, y, 'Found 3 files')
    y += LINE * 1.5
    text(d, x, y, [('● ', GREEN), ('Read', INK), ('(README.md)', MUTED)])
    y += LINE
    result(d, x, y, 'Read 214 lines')
    y += LINE * 2
    text(d, x, y, [('● ', INK), ('It uses three, all in ', INK), ('docs/media/', ORANGE), (':', INK)])
    y += LINE * 1.5
    items = [('sunset.gif', 'the hero, the sun sinking'), ('neon-grid.png', 'the section headers'), ('mountains.jpg', 'the footer')]
    chip_x = W - 24 * X - FONT.getlength('neon-grid.png') - 8 * X
    rows = []
    for n, (name, what) in enumerate(items, 1):
        text(d, x + CELL * 2, y, [(f'{n}. ', INK), (name, ORANGE), (f' — {what}', INK)])
        rows.append(y)
        hovered = n == HOVERED
        label_w = d.textlength(name, font=FONT)
        if hovered:
            d.rectangle((chip_x - 3 * X, y - LINE * 0.42, chip_x + label_w + 3 * X, y + LINE * 0.42), fill=ORANGE)
        d.text((chip_x, y), name, font=FONT, fill=DARK_INK if hovered else ORANGE, anchor='lm')
        y += LINE
    prompt_box(img, d, x - 6 * X, H - 60 * X, W - 2 * x + 12 * X)

    # The card of the hovered chip: the picture and its path, over the rows above that item.
    pw, ph = 372 * X, 150 * X
    pic = sunset(pw, ph, 0.14)
    card_w, card_h = pw + 2 * 10 * X, ph + 2 * 10 * X + LINE
    cx0, cy1 = x + CELL * 2, rows[HOVERED - 1] - LINE / 2 - 4 * X
    cy0 = cy1 - card_h
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((cx0 + 6 * X, cy0 + 10 * X, cx0 + card_w + 6 * X, cy1 + 10 * X), 12 * X, fill=(4, 2, 12, 170))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(12 * X)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((cx0, cy0, cx0 + card_w, cy1), 12 * X, fill=WINDOW, outline=(150, 132, 180), width=X)
    img.paste(pic, (int(cx0 + 10 * X), int(cy0 + 10 * X)))
    d.text((cx0 + 10 * X, cy1 - LINE / 2 - 4 * X), f'docs/media/{items[HOVERED - 1][0]}', font=FONT, fill=MUTED, anchor='lm')
    # The pointer on the chip.
    px, py = chip_x + d.textlength('sun', font=FONT), rows[HOVERED - 1] + 2 * X
    arrow = [(0, 0), (0, 17), (4.5, 13), (7.5, 20), (10, 19), (7, 12.5), (12.5, 12.5)]
    d.polygon([(px + ax * X * 1.2, py + ay * X * 1.2) for ax, ay in arrow], fill=INK, outline=(20, 10, 30))
    finish(img).save(os.path.join(OUT, 'chips.png'), optimize=True)


# --- docs/pixels-and-cells.png: the same picture in pixels and in cells.
def in_cells(pic, cell_w):
    """The picture as a terminal draws it in text: each cell twice as tall as wide, an upper and a
    lower color, as the half block ▀ splits it."""
    columns, rows = pic.width // cell_w, pic.height // (cell_w * 2)
    halves = pic.resize((columns, rows * 2), Image.BOX)
    return halves.resize((columns * cell_w, rows * cell_w * 2), Image.NEAREST)


def pixels_and_cells():
    pw, ph = 380 * X, 214 * X
    pic = sunset(pw, ph, 0.06)
    panels = []
    for title, caption, picture in [
        ('Ghostty · kitty', 'pixels: the terminal draws the picture itself', pic),
        ('Terminal.app · VS Code · …', 'cells: colored blocks, in any true-color terminal', in_cells(pic, 8 * X)),
    ]:
        W, H = pw + 48 * X, ph + 150 * X
        img, d, (x, y) = window(W, H, title)
        text(d, x, y, [('● ', GREEN), ('Read', INK), ('(sunset.png)', MUTED)])
        y += LINE
        result(d, x, y, 'Read image (152KB)')
        y += LINE * 0.75
        img.paste(picture, (int(x), int(y)))
        d.text((W / 2, H - 22 * X), caption, font=SMALL, fill=MUTED, anchor='mm')
        panels.append(img)
    gap = 28 * X
    out = Image.new('RGBA', (panels[0].width * 2 + gap, panels[0].height), (0, 0, 0, 0))
    out.paste(panels[0], (0, 0), panels[0])
    out.paste(panels[1], (panels[0].width + gap, 0), panels[1])
    finish(out).save(os.path.join(OUT, 'pixels-and-cells.png'), optimize=True)


os.makedirs(OUT, exist_ok=True)
demo()
chips()
pixels_and_cells()
