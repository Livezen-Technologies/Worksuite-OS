#!/usr/bin/env python3
"""GRUB theme pixmaps: rounded 9-slice pieces (anti-aliased), no dependencies.
   make-pixmaps.py OUTDIR [live]  →  progress_bar_*.png (track), progress_highlight_*.png (fill), select_*.png (selection)
   "live": only the ISO menu's selection pill (solid WorkSuite blue, radius 10).
GRUB builds a styled box from <prefix>_{nw,n,ne,w,c,e,sw,s,se}.png; the corners carry the rounding."""
import struct, sys, zlib, os

def png(path, w, h, px):
    raw = b''.join(b'\0' + bytes(c for p in px[y * w:(y + 1) * w] for c in p) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def box(out, prefix, r, rgb, alpha):
    """Pieces of a rounded rectangle with corner radius r (px), colour rgb, opacity alpha (0..1)."""
    def cov(x, y, cx, cy):          # 4x4 supersampled coverage of pixel (x, y) inside the circle at (cx, cy)
        n = 0
        for i in range(4):
            for j in range(4):
                dx, dy = x + (i + .5) / 4 - cx, y + (j + .5) / 4 - cy
                n += dx * dx + dy * dy <= r * r
        return n / 16
    def piece(name, w, h, f):
        png(os.path.join(out, f'{prefix}_{name}.png'), w, h, [(*rgb, round(255 * alpha * f(x, y))) for y in range(h) for x in range(w)])
    piece('nw', r, r, lambda x, y: cov(x, y, r, r))
    piece('ne', r, r, lambda x, y: cov(x, y, 0, r))
    piece('sw', r, r, lambda x, y: cov(x, y, r, 0))
    piece('se', r, r, lambda x, y: cov(x, y, 0, 0))
    for name, w, h in (('n', 1, r), ('s', 1, r), ('w', r, 1), ('e', r, 1), ('c', 1, 1)):
        piece(name, w, h, lambda x, y: 1)

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
if sys.argv[2:] == ['live']:
    box(out, 'select', 10, (0x1f, 0x6b, 0xff), 1.0)
    sys.exit(0)
box(out, 'progress_bar', 3, (0x1e, 0x29, 0x3b), 1.0)          # track
box(out, 'progress_highlight', 3, (0x0a, 0x6c, 0xff), 1.0)    # fill, WorkSuite blue
box(out, 'select', 4, (0x0a, 0x6c, 0xff), 0.28)               # selected menu item
