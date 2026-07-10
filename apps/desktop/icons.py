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

from PIL import Image, ImageDraw

BRAND = (79, 66, 224, 255)  # sampled from logo.png
WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)


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
    """Brand-coloured squircle, white mark, transparent margin."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # Apple's grid: the tile occupies ~82% of the canvas, centred.
    m = size * 0.09
    d.rounded_rectangle((m, m, size - m, size - m), radius=size * 0.225, fill=BRAND)

    u = size * 0.052
    lines(d, size * 0.24, size * 0.33, u, WHITE)
    bars(d, size * 0.55, size * 0.60, u, WHITE)
    # A tail on the tile would touch the edge; the bubble here *is* the tile.
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
