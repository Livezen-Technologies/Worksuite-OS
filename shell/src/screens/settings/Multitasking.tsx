// Settings › Multitasking (WSOS-DSK-003), like Windows 11: the Task View button, and which desktops' windows the
// taskbar and Alt+Tab show (both "Only the desktop I'm using" by default). Stored in the synced shell preferences;
// Alt+Tab's scope is Labwc's window switcher, set through the Wayland bridge.
import { useEffect, useState } from 'react'
import { BigSwitch } from './ui'
import { card, field, rowLine, sectionLabel } from '../../components/Dk'
import { os } from '../../lib/os'
import { panel } from '../../lib/panel'
import { shellPrefsFrom } from '../../lib/shellPrefs'
import { DEFAULT_DESKTOP_PREFS, MAX_DESKTOPS, saveDesktopPrefs, useDesktopPrefs, type DesktopPrefs, type Scope } from '../../lib/desktops'
import { useWorkspaces } from '../../components/PanelItems'
import { t } from '../../i18n'

type Sync = Parameters<typeof saveDesktopPrefs>[1]

export function MultitaskingPanel({ sync = os }: { sync?: Sync }) {
  const live = useDesktopPrefs()
  const [p, setP] = useState<DesktopPrefs>(live)
  const ws = useWorkspaces()
  useEffect(() => setP(live), [live])
  useEffect(() => {
    let on = true
    void sync.shellPrefs().then((r) => { if (on && r.ok) setP(shellPrefsFrom(r.value).desktops ?? { ...DEFAULT_DESKTOP_PREFS, ...live }) }).catch(() => undefined)
    return () => { on = false }
  }, [sync]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: DesktopPrefs) => {
    setP(next)
    if (next.altTab !== p.altTab) void panel.setSwitcherAllDesktops?.(next.altTab === 'all')
    void saveDesktopPrefs(next, sync)
  }
  const scope = (id: 'taskbar' | 'altTab', label: string) => (
    <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
      <label htmlFor={`mt-${id}`} className="flex-1 text-sm font-medium">{label}</label>
      <select id={`mt-${id}`} value={p[id]} className={field} onChange={(e) => save({ ...p, [id]: e.target.value as Scope })}>
        <option value="current">{t('mt.current')}</option>
        <option value="all">{t('mt.all')}</option>
      </select>
    </div>
  )
  return (
    <>
      <h1 className="m-0 text-[28px] font-bold">{t('settings.nav.Multitasking')}</h1>
      <section aria-labelledby="mt-desktops" className="flex flex-col gap-2">
        <h2 id="mt-desktops" className={`m-0 font-normal ${sectionLabel}`}>{t('mt.desktops')}</h2>
        {!ws.supported && <p role="note" className="m-0 text-[13px] text-[#8FA3C8]">{t('mt.unavailable')}</p>}
        <div className={`${card} overflow-hidden`}>
          <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{t('mt.taskViewButton')}</span><span className="text-xs text-[#8FA3C8]">{t('mt.taskViewButtonSub')}</span></span>
            <BigSwitch label={t('mt.taskViewButton')} checked={p.taskViewButton} onChange={(v) => save({ ...p, taskViewButton: v })} />
          </div>
          {scope('taskbar', t('mt.taskbar'))}
          {scope('altTab', t('mt.altTab'))}
        </div>
        {ws.supported && <p className="m-0 text-[13px] text-[#C9D6EE]">{t('mt.count', { count: ws.count, max: MAX_DESKTOPS })}</p>}
        <p className="m-0 text-xs text-[#8FA3C8]">{t('mt.keys')}</p>
      </section>
    </>
  )
}
