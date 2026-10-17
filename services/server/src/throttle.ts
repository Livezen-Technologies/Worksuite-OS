// Failed sign-in throttling, in memory (per process; restarts clear it). Keys are client addresses and account names;
// a key is blocked once it has `max` failures inside the sliding window.
export class Throttle {
  private failures = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max = 10, windowMs = 15 * 60_000) { this.max = max; this.windowMs = windowMs; }

  private recent(key: string, now: number): number[] {
    const r = (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (r.length) this.failures.set(key, r); else this.failures.delete(key);
    return r;
  }

  /** True when any of `keys` has reached the limit. */
  blocked(keys: string[], now = Date.now()): boolean {
    return keys.some((k) => this.recent(k, now).length >= this.max);
  }

  /** Records one failure against each of `keys`. */
  fail(keys: string[], now = Date.now()) {
    for (const k of keys) this.failures.set(k, [...this.recent(k, now), now]);
  }
}
