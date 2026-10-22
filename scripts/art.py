"""What the icon and the README's pictures are drawn with: the palette, the synthwave sunset, a
picture drawn in terminal cells, a framed photo, the chip the mod draws for a picture."""
import math
import random
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

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


def mono(size):
    """A monospaced font: Menlo on macOS, DejaVu Sans Mono elsewhere; Pillow's own past both."""
    for path in ['/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default(size)


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
