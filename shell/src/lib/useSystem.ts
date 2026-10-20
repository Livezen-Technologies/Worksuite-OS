// Data hooks for Settings → host services. Layout lives in screens/Settings.tsx; this file only loads state.
import { useCallback, useEffect, useState } from 'react'
import { os, type Avail } from './os'
import { t } from '../i18n'

/** null while loading; then the bridge answer (possibly `available: false`). Refreshes every `pollMs` if set. */
export function useSystem<T>(load: () => Promise<Avail<T>>, pollMs?: number) {
  const [state, setState] = useState<Avail<T> | null>(null)
  const reload = useCallback(() => load().then(setState, () => setState({ available: false, reason: 'service_unavailable' })), [load])
  useEffect(() => {
    void reload()
    if (!pollMs) return
    const t = setInterval(() => void reload(), pollMs)
    return () => clearInterval(t)
  }, [reload, pollMs])
  return { state, reload }
}

export const loaders = {
  network: () => os.sysNetwork(),
  bluetooth: () => os.sysBluetooth(),
  sound: () => os.sysSound(),
  battery: () => os.sysBattery(),
  printers: () => os.sysPrinters(),
  displays: () => os.sysDisplays(),
  disks: () => os.sysDisks(),
}

/** Text for an `available: false` reason. */
export function unavailableText(reason: string): string {
  switch (reason) {
    case 'no_adapter': return t('sys.noAdapter')
    case 'no_battery': return t('sys.noBattery')
    case 'service_unavailable':
    case 'service_stopped': return t('sys.service')
    default: return reason.endsWith('_missing') ? t('sys.missing') : t('sys.na')
  }
}
