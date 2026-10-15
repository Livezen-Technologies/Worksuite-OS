// WSOS-SYN-003: exponential backoff with jitter, 1 s start, 5 min cap.
export const BACKOFF_START_MS = 1_000;
export const BACKOFF_CAP_MS = 300_000;

/** attempts = number of failures so far (>= 1). rand in [0,1). Result in [0.5·d, d], d = min(cap, start·2^(n-1)). */
export function backoffDelay(attempts: number, rand: number = Math.random()): number {
  const d = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(d / 2 + (d / 2) * rand);
}
