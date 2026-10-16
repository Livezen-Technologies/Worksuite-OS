import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQRModule from 'jsqr';
const jsQR = jsQRModule as unknown as typeof jsQRModule.default;
import { qrMatrix } from '../src/qr.ts';

/** Renders the matrix with a 4-module quiet zone at 6 px per module and decodes it with an independent reader. */
function decode(rows: string[]): string | null {
  const n = rows.length, scale = 6, q = 4, w = (n + 2 * q) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (rows[y][x] === '1') {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const o = (((y + q) * scale + dy) * w + (x + q) * scale + dx) * 4;
      px[o] = px[o + 1] = px[o + 2] = 0;
    }
  }
  return jsQR(px, w, w)?.data ?? null;
}

test('QR codes decode back to the text, from version 1 to 10', () => {
  for (const text of ['A', 'https://ws.example.com/enroll#token=wse_' + 'x'.repeat(43), 'ශ්‍රී ලංකා · தமிழ்', 'y'.repeat(150), 'z'.repeat(213)]) {
    const m = qrMatrix(text);
    assert.equal(m.length, m[0].length);
    assert.equal(decode(m), text, `${text.length} chars, ${m.length} modules`);
  }
});

test('QR sizes follow the version and over-long text is refused', () => {
  assert.equal(qrMatrix('hello').length, 21);
  assert.equal(qrMatrix('z'.repeat(213)).length, 57);
  assert.throws(() => qrMatrix('z'.repeat(214)));
});
