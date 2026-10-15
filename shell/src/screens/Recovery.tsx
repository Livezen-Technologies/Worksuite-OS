// WorkSuite Recovery (§9.2; docs/design/boot-install/project R1–R6): menu, unlock with recovery key, startup
// repair, restore a snapshot, reinstall, complete. Everything shown comes from the OS bridge; features without a
// service yet are shown disabled with a reason.
import { useCallback, useEffect, useReducer, useState } from 'react'
import type { RecoveryProps } from './types'
import { os, type RecoveryInfo } from '../lib/os'
import { initialRecovery, recoveryReducer, type DoneInfo } from '../lib/recovery'
import Menu from './recovery/Menu'
import Unlock from './recovery/Unlock'
import Repair from './recovery/Repair'
import Snapshots from './recovery/Snapshots'
import Reset from './recovery/Reset'
import Done from './recovery/Done'

export default function Recovery(_props: RecoveryProps) {
  const [s, dispatch] = useReducer(recoveryReducer, initialRecovery)
  const [info, setInfo] = useState<RecoveryInfo | null>(null)
  const back = useCallback(() => dispatch({ type: 'back' }), [])
  const finish = useCallback((done: DoneInfo) => dispatch({ type: 'finish', done }), [])

  // Re-read disks and features whenever the menu shows (e.g. after unlocking).
  useEffect(() => {
    if (s.screen !== 'menu') return
    let alive = true
    void os.recoveryInfo().then((i) => { if (alive) setInfo(i) })
    return () => { alive = false }
  }, [s.screen])

  switch (s.screen) {
    case 'unlock': return <Unlock info={info} onBack={back} onDone={finish} />
    case 'repair': return <Repair onBack={back} onDone={finish} />
    case 'snapshots': return <Snapshots onBack={back} onDone={finish} />
    case 'reset': return <Reset info={info} onBack={back} onDone={finish} />
    case 'done': return s.done ? <Done done={s.done} canSaveReport={!!info?.features.report_usb} onBack={back} /> : null
    default: return <Menu info={info} onOpen={(screen) => dispatch({ type: 'open', screen })} />
  }
}
