"""Draws the README's pictures, illustrations of what the mod does, in the icon's palette:

- docs/demo.gif: how it is used: a prompt typed and sent, Claude reads a GIF, the GIF plays under its
  row, the pointer comes onto it and it opens larger in a window by the pointer, then closes;
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


# --- docs/demo.gif: how it is used.
ARROW = [(0, 0), (0, 17), (4.5, 13), (7.5, 20), (10, 19), (7, 12.5), (12.5, 12.5)]
PROMPT = 'what is in docs/media/sunset.gif?'


def pointer(d, x, y):
    """The pointer, its tip at (x, y)."""
    d.polygon([(x + ax * X * 1.3, y + ay * X * 1.3) for ax, ay in ARROW], fill=INK, outline=(20, 10, 30))


def popup(img, x, y, pic, shown):
    """The window by the pointer: borderless, rounded, a shadow under it, the picture in it, grown to
    `shown` (0 to 1) as it opens. Answers the image drawn on."""
    pad = 6 * X
    w, h = pic.width + pad * 2, pic.height + pad * 2
    s = 0.86 + 0.14 * shown
    sw, sh = int(w * s), int(h * s)
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x + 4 * X, y + 10 * X, x + sw + 4 * X, y + sh + 10 * X), 10 * X, fill=(4, 2, 12, int(190 * shown)))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(14 * X)))
    body = Image.new('RGBA', (w, h), (58, 46, 86, 255))
    body.paste(pic, (pad, pad))
    body = body.resize((sw, sh), Image.LANCZOS)
    body.putalpha(Image.eval(rounded_mask((sw, sh), 10 * X), lambda a: int(a * shown)))
    img.alpha_composite(body, (int(x), int(y)))
    return img


def demo():
    W, H = 900 * X, 540 * X
    pw, ph = 330 * X, 186 * X
    big = (470 * X, 265 * X)
    # The frames, each its time on screen: the prompt typed, sent, the read, the pointer coming, the
    # window opening, held, the pointer leaving.
    typed = list(range(0, len(PROMPT) + 1, 3)) + [len(PROMPT)]
    steps = [('type', n, 60) for n in typed] + [('type', len(PROMPT), 400)]
    steps += [('read', 0, 500)]
    steps += [('come', t / 7, 70) for t in range(8)]
    steps += [('open', t / 3, 60) for t in range(1, 4)]
    steps += [('held', t, 110) for t in range(16)]
    steps += [('leave', t / 5, 70) for t in range(6)]
    steps += [('rest', t, 110) for t in range(6)]
    frames, durations = [], []
    for i, (phase, value, ms) in enumerate(steps):
        img, d, (x, y) = window(W, H, '~/sunset — claude')
        sink = 0.07 + 0.11 * math.sin(2 * math.pi * i / 24)
        is_sent = phase != 'type'
        if is_sent:
            user_row(img, d, x, y, PROMPT)
            y += LINE * 2
            text(d, x, y, [('● ', GREEN), ('Read', INK), ('(docs/media/sunset.gif)', MUTED)])
            y += LINE
            result(d, x, y, 'Read image (152KB)')
            y += LINE * 0.75
            left, top = int(x + CELL * 5), int(y)
            img.paste(sunset(pw, ph, sink), (left, top))
            y += ph + LINE * 1.0
            text(d, x, y, [('● ', INK), ('A synthwave sunset: the sun sinks behind violet mountains,', INK)])
            y += LINE
            text(d, x, y, [('  over a neon grid that runs to the horizon.', INK)])
        box_y = H - 60 * X
        prompt_box(img, d, x - 6 * X, box_y, W - 2 * x + 12 * X, cursor=is_sent and i % 8 < 4)
        if not is_sent:
            # What is typed so far, the cursor after it.
            end = text(d, x - 6 * X + 14 * X + CELL * 2, box_y + 20 * X, [(PROMPT[:value], INK)])
            d.rectangle((end, box_y + 11 * X, end + CELL * 0.9, box_y + 29 * X), fill=INK)
        # The pointer: from the foot of the window onto the picture, then away to the right.
        start, on, away = (W * 0.78, H * 0.80), (left + pw * 0.55, top + ph * 0.45) if is_sent else (0, 0), (W * 0.86, H * 0.62)
        ease = lambda t: t * t * (3 - 2 * t)
        if phase == 'read':
            at = start
        elif phase == 'come':
            t = ease(value)
            at = (start[0] + (on[0] - start[0]) * t, start[1] + (on[1] - start[1]) * t)
        elif phase in ('open', 'held'):
            at = on
        elif phase == 'leave':
            t = ease(value)
            at = (on[0] + (away[0] - on[0]) * t, on[1] + (away[1] - on[1]) * t)
        elif phase == 'rest':
            at = away
        else:
            at = None
        # The window by the pointer, below it and to its right, never over it.
        shown = value if phase == 'open' else 1.0 if phase == 'held' else 0
        if shown > 0:
            img = popup(img, at[0] + 18 * X, at[1] + 18 * X - big[1] * 0.55, sunset(*big, sink), shown)
            d = ImageDraw.Draw(img)
        if at is not None:
            pointer(d, *at)
        frames.append(finish(img))
        durations.append(ms)
    save_gif(frames, durations, 'demo.gif')


def save_gif(frames, durations, name):
    # One palette for every frame, so only what moves changes from one to the next; it holds the
    # window's few strong colors (the dots, the bullet, the chevron) and the corners' see-through one.
    keep = [PAGE, GREEN, ORANGE, INK, MUTED, (255, 95, 87), (254, 188, 46), (40, 200, 64)]
    sample = frames[-12].convert('RGB')
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
    out[0].save(os.path.join(OUT, name), save_all=True, append_images=out[1:], duration=durations, loop=0, optimize=False, disposal=1, transparency=clear)


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
pixels_and_cells()
