// Touch calibration (board TouchCalibrate): four taps on known targets give a least-squares affine fit from where the
// touches landed to where the targets are. The result is a libinput calibration matrix (a b c d e f, in normalised
// output coordinates) that Labwc applies through rc.xml (electron/touch.ts). Taps are measured with the current
// matrix in force, so the new matrix is the fit composed with the current one.
export type Matrix = [number, number, number, number, number, number]
export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0]
/** Where the four targets sit, as fractions of the screen (top left, top right, bottom right, bottom left). */
export const TARGETS: [number, number][] = [[0.08, 0.1], [0.92, 0.1], [0.92, 0.9], [0.08, 0.9]]

function solve3(m: number[][], v: number[]): number[] | null {
  const a = m.map((r, i) => [...r, v[i]])
  for (let c = 0; c < 3; c++) {
    let p = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r
    if (Math.abs(a[p][c]) < 1e-12) return null
    ;[a[c], a[p]] = [a[p], a[c]]
    for (let r = 0; r < 3; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k] }
  }
  return a.map((r, i) => r[3] / r[i])
}

/** Least-squares affine map from measured (u, v) to target (x, y); null when the points don't span the screen. */
export function fitAffine(measured: [number, number][], target: [number, number][]): Matrix | null {
  const n = Math.min(measured.length, target.length)
  if (n < 3) return null
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const row = [measured[i][0], measured[i][1], 1]
    for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) ata[r][c] += row[r] * row[c]; bx[r] += row[r] * target[i][0]; by[r] += row[r] * target[i][1] }
  }
  const x = solve3(ata, bx), y = solve3(ata, by)
  return x && y ? [x[0], x[1], x[2], y[0], y[1], y[2]] : null
}

/** a ∘ b: apply b first, then a. */
export function compose(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]]
}

/** Mean distance in pixels between the corrected taps and the targets on a w×h screen. */
export function meanError(m: Matrix, measured: [number, number][], target: [number, number][], w: number, h: number): number {
  const d = measured.map(([u, v], i) => Math.hypot((m[0] * u + m[1] * v + m[2] - target[i][0]) * w, (m[3] * u + m[4] * v + m[5] - target[i][1]) * h))
  return d.reduce((a, x) => a + x, 0) / Math.max(1, d.length)
}

/** Usable: scale terms within ±4 and offsets within ±2, the same bounds the settings file accepts. */
export const sane = (m: Matrix) => m.every(Number.isFinite) && [0, 1, 3, 4].every((i) => Math.abs(m[i]) <= 4) && [2, 5].every((i) => Math.abs(m[i]) <= 2)
