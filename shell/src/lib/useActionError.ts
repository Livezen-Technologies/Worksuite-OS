// Settings and Quick Settings actions (Wi-Fi, Bluetooth, sound, power mode …) return Avail results: a failed one used to
// be dropped, so nothing happened and nothing said why. run() keeps the failure so the panel can show it inline.
import { useCallback, useState } from 'react'

/** The failure reason in an Avail/Reply-shaped result, or null when it succeeded (or returned nothing to judge). */
export function failureOf(r: unknown): string | null {
  if (!r || typeof r !== 'object') return null
  const o = r as { available?: unknown; ok?: unknown; reason?: unknown; error?: unknown }
  if (o.available === false || o.ok === false) return String(o.reason ?? o.error ?? 'failed')
  return null
}

export function useActionError(after?: () => unknown) {
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (p: Promise<unknown> | undefined) => {
    let reason: string | null
    try { reason = failureOf(await p) } catch (e) { reason = (e as Error)?.message || 'failed' }
    setError(reason)
    try { await after?.() } catch { /* the panel's own reload reports its state */ }
    return reason === null
  }, [after])
  return { error, run, clear: () => setError(null) }
}
