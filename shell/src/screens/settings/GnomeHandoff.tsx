// Under GNOME (WorkSuite Settings window, electron/bootmode.ts 'control'), sections whose WorkSuite backend drives the old
// Labwc desktop (wlr-randr, Labwc's rc.xml, swayidle/gtklock, the shell as notification and clipboard server) would
// change nothing. They hand off to the matching GNOME Settings panel, which configures Mutter and GNOME Shell for real.
import { useEffect, useState } from 'react'
import { os } from '../../lib/os'
import { t, type MessageKey } from '../../i18n'
import { H1, Note } from './ui'

/** WorkSuite section → gnome-control-center panel (names checked against GNOME 48's `gnome-control-center --list`). */
export const GNOME_PANELS: Record<string, string> = {
  Display: 'display', 'Mouse & touchpad': 'mouse', Keyboard: 'keyboard', Multitasking: 'multitasking',
  'Touchscreen & pen': 'wacom', 'Lock screen': 'privacy', Appearance: 'background', Notifications: 'notifications',
  Clipboard: 'privacy',
}
export const isGnomeSession = () => new URLSearchParams(location.search).get('mode') === 'control'

export function GnomeHandoff({ section }: { section: string }) {
  const panel = GNOME_PANELS[section]
  const [err, setErr] = useState(false)
  const open = () => void os.openGnomeSettings(panel).then((r) => setErr(!r.ok))
  useEffect(() => { open() }, [panel]) // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <H1>{t(`settings.nav.${section}` as MessageKey)}</H1>
    <div className="flex flex-col items-start gap-3 rounded-[14px] border border-[rgba(127,178,255,0.12)] bg-[rgba(14,32,72,0.6)] px-5 py-[18px]">
      <span className="text-[15px] font-semibold">{t('settings.gnome.title')}</span>
      <span className="text-[13px] text-[#C9D6EE]">{t('settings.gnome.body')}</span>
      <button type="button" onClick={open} className="h-10 rounded-xl bg-[#1F6BFF] px-4 text-[14px] font-semibold text-white">{t('settings.gnome.open')}</button>
      {err && <span role="alert" className="text-[13px] text-[#FFB4A6]">{t('settings.gnome.failed')}</span>}
    </div>
    <Note>{t('settings.gnome.note')}</Note>
  </>
}
