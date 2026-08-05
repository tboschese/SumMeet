#!/usr/bin/env python3
"""Draws SumMeet's app icon (Dock) and menu-bar icon from the brand mark.

Two icons, two rules, and they are opposites:

  • The Dock icon is artwork: the brand colour, drawn inside the macOS squircle with
    the inset Apple's grid expects. It must have a *transparent* canvas — a white
    background reads as a white tile on every dark Dock — and it must be .icns, which
    is the only format the Dock reads.

  • The menu-bar icon is a template: black plus alpha, no colour at all, because the
    system recolours it for the light and dark bar. A filled silhouette inverts into
    a white blob, so it is drawn as a stroke.
"""

from PIL import Image, ImageChops, ImageDraw, ImageFilter

BRAND = (79, 66, 224, 255)  # sampled from logo.png
WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)

# Warm, soft palette (Granola-ish): a sunrise gradient tile with a cream bubble and a
# terracotta mark. Warm reads friendlier than the flat brand purple, and the light bubble
# keeps the transcript/insights mark legible.
GRAD_TOP = (255, 210, 156)     # warm amber-cream
GRAD_BOTTOM = (240, 133, 86)   # soft warm orange
CREAM = (255, 249, 240, 255)   # the bubble
TERRA = (200, 92, 48, 255)     # the mark inside the bubble


def warm_gradient(size, top, bottom):
    """A smooth top-to-bottom warm gradient, size×size RGB."""
    col = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        col.putpixel(
            (0, y),
            (
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )
    return col.resize((size, size))


def bubble(draw, box, radius, tail_x, colour, width=None):
    """Rounded speech bubble with the tail below its lower-left."""
    if width:
        draw.rounded_rectangle(box, radius=radius, outline=colour, width=width)
    else:
        draw.rounded_rectangle(box, radius=radius, fill=colour)
    span = box[2] - box[0]
    tail_y = box[3]
    draw.polygon(
        [
            (tail_x, tail_y - span * 0.03),
            (tail_x + span * 0.16, tail_y - span * 0.03),
            (tail_x + span * 0.03, tail_y + span * 0.16),
        ],
        fill=colour,
    )


def bars(draw, x0, base, unit, colour):
    """The mark's three ascending bars."""
    w = unit * 0.9
    for i, height in enumerate((unit * 1.7, unit * 2.7, unit * 3.7)):
        x = x0 + i * unit * 1.65
        draw.rounded_rectangle((x, base - height, x + w, base), radius=w / 2, fill=colour)


def lines(draw, x0, y0, unit, colour):
    """The mark's three transcript lines, shortest last."""
    for i, length in enumerate((unit * 5.2, unit * 4.2, unit * 3.4)):
        y = y0 + i * unit * 1.5
        draw.rounded_rectangle((x0, y, x0 + length, y + unit * 0.75),
                               radius=unit * 0.38, fill=colour)


def app_icon(size=1024):
    """Warm gradient squircle, a cream speech bubble, a terracotta mark inside it."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Apple's grid: the tile occupies ~82% of the canvas, centred.
    m = size * 0.09
    radius = size * 0.225

    # Fill the squircle with the warm gradient (draw the mask, paste the gradient).
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (m, m, size - m, size - m), radius=radius, fill=255
    )
    im.paste(warm_gradient(size, GRAD_TOP, GRAD_BOTTOM).convert("RGBA"), (0, 0), mask)

    # A soft top highlight for depth: a feathered translucent-white ellipse, clipped to
    # the tile so it can't spill past the rounded corners.
    hi = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hi).ellipse(
        (size * 0.12, -size * 0.35, size * 0.88, size * 0.42), fill=(255, 255, 255, 55)
    )
    hi = hi.filter(ImageFilter.GaussianBlur(size * 0.05))
    hi.putalpha(ImageChops.multiply(hi.getchannel("A"), mask))
    im.alpha_composite(hi)

    d = ImageDraw.Draw(im)

    # A cream speech bubble, centred, with the three ascending "insight" bars inside it.
    box = (size * 0.255, size * 0.235, size * 0.745, size * 0.655)
    bubble(d, box, radius=int(size * 0.10), tail_x=size * 0.315, colour=CREAM)
    u = size * 0.046
    bars(d, size * 0.405, size * 0.560, u, TERRA)
    return im


def tray_icon(size=36):
    """Template image: stroke, not silhouette."""
    scale = 8
    s = size * scale
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    m = s * 0.10
    stroke = max(1, int(s * 0.055))
    box = (m, m, s - m, s - m * 1.9)
    bubble(d, box, radius=int(s * 0.20), tail_x=s * 0.30, colour=BLACK, width=stroke)
    bars(d, s * 0.36, box[3] - s * 0.10, s * 0.055, BLACK)
    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os
    import subprocess
    import sys

    out = os.path.join(os.path.dirname(__file__), "src-tauri", "icons")
    os.makedirs(out, exist_ok=True)

    master = app_icon(1024)
    master.save(os.path.join(out, "icon.png"))

    for size in (18, 36):
        tray_icon(size).save(
            os.path.join(out, "tray-icon.png" if size == 18 else "tray-icon@2x.png")
        )

    # .icns is the only thing the Dock reads.
    iconset = os.path.join(out, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for size in (16, 32, 128, 256, 512):
        master.resize((size, size), Image.LANCZOS).save(
            os.path.join(iconset, f"icon_{size}x{size}.png"))
        master.resize((size * 2, size * 2), Image.LANCZOS).save(
            os.path.join(iconset, f"icon_{size}x{size}@2x.png"))

    icns = os.path.join(out, "icon.icns")
    result = subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns])
    subprocess.run(["rm", "-rf", iconset])
    if result.returncode != 0:
        sys.exit("iconutil failed")
    print(f"wrote {icns}")
