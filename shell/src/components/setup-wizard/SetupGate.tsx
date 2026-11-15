// First run picks its screens: the setup wizard when the setup service (lk.worksuite.Setup1) is running and setup
// hasn't finished, otherwise the shell's own first-run screens (`fallback`). Systems without worksuite-setup, and the
// browser preview without ?setup=, keep the first run they had.
import { useEffect, useState, type ReactNode } from 'react'
import type { SetupApi } from '../../lib/setupApi'
import SetupWizard from './SetupWizard'

export default function SetupGate({ api, fallback, onDone, onExitToRecovery, userName }: { api: SetupApi | null; fallback: ReactNode; onDone: () => void; onExitToRecovery?: () => void; userName?: string }) {
  const [use, setUse] = useState<boolean | null>(api ? null : false)
  useEffect(() => {
    if (!api) return
    let alive = true
    void api.state().then((r) => { if (alive) setUse(r.ok && r.value.state !== 'SETUP_COMPLETED') }).catch(() => { if (alive) setUse(false) })
    return () => { alive = false }
  }, [api])
  if (use === null) return null
  return use && api ? <SetupWizard api={api} onDone={onDone} onExitToRecovery={onExitToRecovery} userName={userName} /> : <>{fallback}</>
}
