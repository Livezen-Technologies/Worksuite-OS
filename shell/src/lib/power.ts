// Helpers for the power menu, the shutdown confirmation and notification lists.

export const SHUTDOWN_SECONDS = 60

/** stroke-dasharray for the countdown ring: the remaining share of the circle. */
export function ringDash(secs: number, total = SHUTDOWN_SECONDS, r = 28): string {
  const c = 2 * Math.PI * r
  const s = Math.max(0, Math.min(total, secs))
  return `${((c * s) / total).toFixed(1)} ${c.toFixed(1)}`
}

/** "Up for 3 h 42 min" / "Up for 5 min" / "Up for less than a minute". */
export function uptimeLabel(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000)
  if (mins < 1) return 'Up for less than a minute'
  const h = Math.floor(mins / 60), m = mins % 60
  if (!h) return `Up for ${m} min`
  return m ? `Up for ${h} h ${m} min` : `Up for ${h} h`
}

/** Notification age for lists: now, 5m, 2h, 3d. */
export function ageLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
