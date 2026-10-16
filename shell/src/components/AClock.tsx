import { useEffect, useState } from 'react'
import { formatTime, localeTag } from '../i18n'

/** Live clock: re-renders on each minute boundary (or every `ms`). */
export function useANow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

export const aTime = (d: Date) => formatTime(d)
export const aShortDate = (d: Date) => d.toLocaleDateString(localeTag(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
export const aLongDate = (d: Date) => d.toLocaleDateString(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' })
