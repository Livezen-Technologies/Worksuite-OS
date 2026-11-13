# Derive the sign-in/lock variant of a WorkSuite wallpaper (worksuite-N-lock.png): the centred logo is replaced by the
# background around it (per-column interpolation between the rows above and below the logo band, smoothed, blended with
# a feathered mask), so the sign-in card and the lock clock sit on calm sky. The originals are never changed.
# Run: python3 -I branding/wallpapers/derive-lock.py worksuite-N.png worksuite-N-lock.png
import sys
import numpy as np
from PIL import Image, ImageFilter
src, dst = sys.argv[1], sys.argv[2]
im = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
h, w, _ = im.shape
# The logo band (mark + wordmark), measured on the 1671x941 artwork; generous margins.
y0, y1 = int(h * 0.33), int(h * 0.64)
x0, x1 = int(w * 0.17), int(w * 0.83)
top = im[y0 - 6:y0].mean(axis=0)        # (w,3)
bot = im[y1:y1 + 6].mean(axis=0)
t = np.linspace(0, 1, y1 - y0)[:, None, None]
fill = top[None] * (1 - t) + bot[None] * t
out = im.copy()
out[y0:y1] = fill
# Smooth the fill horizontally (removes column streaks) and blend it in with a feathered mask.
sm = np.asarray(Image.fromarray(out.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(28))).astype(np.float32)
mask = np.zeros((h, w), np.float32); mask[y0:y1, x0:x1] = 1
mask = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(40))).astype(np.float32)[..., None] / 255
mask = np.clip(mask * 2.2, 0, 1)  # fully replaced inside the band, feathered only at its edges
res = im * (1 - mask) + sm * mask
Image.fromarray(res.clip(0, 255).astype(np.uint8)).save(dst, optimize=True)
