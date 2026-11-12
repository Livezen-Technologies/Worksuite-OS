// Under GNOME the shell is not the desktop (electron/bootmode.ts): WorkSuite Settings and WorkSuite Setup are ordinary
// windows. These render the existing screens on their own; the main process and every backend are the same.
import { useEffect, useState } from 'react'
import Settings from './Settings'
import SetupGate from '../components/setup-wizard/SetupGate'
import { setupApi } from '../lib/setupApi'
import { os } from '../lib/os'
import { requestSettingsSection } from '../lib/settingsNav'

export function ControlCenter({ section }: { section: string | null }) {
  // The section asked for on the command line, then whatever a later launch asks for.
  useState(() => { if (section) requestSettingsSection(section); return null })
  useEffect(() => os.onSettingsSection((s) => requestSettingsSection(s)), [])
  return (
    <div className="h-screen w-screen overflow-hidden bg-[#061029] text-white">
      <Settings onClose={() => window.close()} active />
    </div>
  )
}

/** First sign-in (worksuite-setup.desktop in GNOME's autostart): the wizard while setup is unfinished, then close. */
export function SetupWindow({ userName }: { userName: string }) {
  const [api] = useState(() => setupApi())
  return (
    <div className="h-screen w-screen overflow-hidden">
      <SetupGate api={api} userName={userName} onDone={() => window.close()} fallback={<CloseNow />} />
    </div>
  )
}
function CloseNow() { useEffect(() => { window.close() }, []); return null }
