// Settings app (boards SetNav, SetNetwork, SetBluetooth, SetDisplay, SetAppearance, SetSound, SetPrivacy, SetUsers,
// UpdSettings, HwSettings). Every value comes from the OS bridge or the shell's own saved settings; where the bridge
// can't tell, the section says so instead of showing sample values.
import { useEffect, useMemo, useRef, useState } from 'react'
import { os, type HwDevice } from '../lib/os'
import type { WindowProps } from './types'
import { needsAttention } from '../lib/updates'
import { useOsUpdate } from '../lib/useOsUpdate'
import { VpnPanel } from './settings/Vpn'
import { PowerPanel } from './settings/Devices'
import { PrintersPanel } from './settings/Printers'
import { GraphicsPanel } from './settings/Graphics'
import { KeyboardPanel, TouchPanel } from './settings/Touch'
import { AIPanel } from './settings/AI'
import { MultitaskingPanel } from './settings/Multitasking'
import { ClipboardPanel } from './settings/Clipboard'
import { onSettingsSection, takeSettingsSection } from '../lib/settingsNav'
import { Svg } from '../components/Dk'
import { Avatar } from '../components/Ws'
import { UpdatesPanel } from './Updates'
import { DeviceProblemDialog, DevicesPanel, DriversPanel } from './Hardware'
import { t } from '../i18n'
// Settings › Display lives in DisplaySettings.tsx (WSOS-DSK-005/006).
import { DisplayPanel } from './DisplaySettings'
import { PointerPanel } from './settings/Pointer'
// Settings › Default apps and clipboard history live in DesktopSettings.tsx (WSOS-DSK-008/009).
import { DefaultAppsPanel } from './DesktopSettings'
// Pairing, drives, power, printers, input methods, rejected sync changes (WSOS-INT-003…006, 011, SYN-004).
import { DeviceExtras } from './PeripheralSettings'
import { NAV, type Section, isSection, navLabel, ALIAS } from './settings/nav'
import { H1 } from './settings/common'
import { NetworkPanel, BluetoothPanel } from './settings/Network'
import { AppearancePanel } from './settings/Appearance'
import { SoundPanel } from './settings/Sound'
import { NotificationsPanel } from './settings/Notifications'
import { PrivacyPanel, LockScreenPanel } from './settings/Privacy'
import { UsersPanel } from './settings/Users'
import { AboutPanel, ManagedPanel } from './settings/About'
export type { Section } from './settings/nav'
// CloudAccounts moved to settings/Accounts.tsx; still exported here for existing imports.
export { CloudAccounts } from './settings/Accounts'


function SetNav({ section, onPick, badges, user }: { section: Section; onPick: (s: Section) => void; badges: Partial<Record<Section, string>>; user: { name: string; role: string } | null }) {
  const [q, setQ] = useState('')
  const items = NAV.filter((n) => navLabel(n.id).toLowerCase().includes(q.trim().toLowerCase()) || n.id.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <nav aria-label={t('launcher.settings')} className="box-border flex w-[260px] shrink-0 flex-col gap-3.5 overflow-auto border-r border-[rgba(127,178,255,0.12)] bg-[#071330] px-3.5 pt-5 pb-[72px]">
      <div className="flex items-center gap-3 px-2 pt-2 pb-1">
        <Avatar name={user?.name ?? '?'} size={40} font={14} />
        <span className="flex min-w-0 flex-col gap-px"><span className="truncate text-sm font-semibold">{user?.name ?? t('settings.thisComputer')}</span><span className="text-xs text-[#8FA3C8]">{user?.role ?? t('launcher.settings')}</span></span>
      </div>
      <label className="flex h-[38px] items-center gap-2 rounded-[9px] border border-[rgba(127,178,255,0.14)] bg-[rgba(4,10,26,0.5)] px-3 text-[13px] text-[#8FA3C8] focus-within:border-[#1F6BFF]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8FA3C8" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        <span className="sr-only">{t('settings.search')}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('settings.search')} className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8]" />
      </label>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {items.map((n) => {
          const on = n.id === section
          const badge = badges[n.id]
          return (
            <li key={n.id}>
              {'sep' in n && n.sep && !q && <div className="mx-2 my-1.5 h-px bg-[rgba(127,178,255,0.1)]" aria-hidden="true" />}
              <button type="button" aria-current={on ? 'page' : undefined} onClick={() => onPick(n.id)}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-[5px] text-left text-sm ${on ? 'bg-[rgba(31,107,255,0.2)] font-semibold text-white' : 'text-[#C9D6EE] hover:bg-white/[0.05]'}`}>
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]" style={{ background: n.tint }}><Svg d={n.icon} size={15} stroke="#FFFFFF" width={2.2} /></span>
                {navLabel(n.id)}
                {badge && <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[#1F6BFF] px-[5px] text-[11px] font-bold text-white" aria-label={t('settings.pending', { count: badge })}>{badge}</span>}
              </button>
            </li>
          )
        })}
        {!items.length && <li className="px-2.5 py-2 text-[13px] text-[#8FA3C8]">{t('settings.noMatch')}</li>}
      </ul>
    </nav>
  )
}

export default function Settings({ onClose, active }: WindowProps) {
  const activeRef = useRef(active)
  activeRef.current = active
  const first = useMemo(() => takeSettingsSection(), [])
  const [section, setSection] = useState<Section>(() => (isSection(first) ? first : (first && ALIAS[first]) || 'Network'))
  // Settings › Keyboard opens on Shortcuts, or on the on-screen keyboard when that was asked for.
  const [kbTab, setKbTab] = useState<'osk' | 'shortcuts'>(first === 'On-screen keyboard' ? 'osk' : 'shortcuts')
  const [problem, setProblem] = useState<HwDevice | null>(null)
  const [driverCount, setDriverCount] = useState(0)
  const [user, setUser] = useState<{ name: string; role: string } | null>(null)
  const { status } = useOsUpdate()
  useEffect(() => onSettingsSection((s) => { setSection(isSection(s) ? s : ALIAS[s] ?? 'Network'); setKbTab(s === 'On-screen keyboard' ? 'osk' : 'shortcuts') }), [])
  useEffect(() => {
    void os.hwDriverReport(false).then((r) => setDriverCount(r.ok ? r.value.offers.length : 0)).catch(() => {})
    void os.sysUsers().then((r) => {
      if (!r.available) return
      const me = r.value.users.find((u) => u.login === r.value.current)
      setUser({ name: me?.name ?? r.value.current, role: me ? (me.admin ? t('settings.users.admin') : t('settings.users.standard')) : t('settings.signedIn') })
    }).catch(() => {})
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && activeRef.current !== false && !document.querySelector('[aria-modal="true"]')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const badges = useMemo(() => ({ ...(driverCount ? { Drivers: String(driverCount) } : {}), ...(needsAttention(status) ? { Updates: '1' } : {}) }), [driverCount, status])

  return (
    <div role="dialog" aria-modal="false" aria-label={t('launcher.settings')} className="relative flex h-full w-full bg-[#0A1A3D] font-sans text-[#E8EEFA]">
      <SetNav section={section} onPick={setSection} badges={badges} user={user} />
      {/* Page frame from the Set* boards: 26/36 px padding, 14 px gap; Privacy & security has its own green tint. */}
      <main className="relative flex min-w-0 flex-1 flex-col gap-3.5 overflow-auto px-9 pt-[26px] pb-[82px] [&>*]:shrink-0" style={{ background: `radial-gradient(ellipse 80% 50% at 80% 0%, ${section === 'Privacy & security' ? 'var(--ws-g-glow-green)' : 'var(--ws-g-glow)'} 0%, var(--ws-g-page) 60%)` }}>
        {section === 'Network' && <NetworkPanel />}
        {section === 'VPN' && <VpnPanel />}
        {section === 'Bluetooth' && <BluetoothPanel />}
        {section === 'Display' && <DisplayPanel />}
        {section === 'Graphics' && <GraphicsPanel onOpen={setSection} />}
        {section === 'Touchscreen & pen' && <TouchPanel />}
        {section === 'Mouse & touchpad' && <PointerPanel />}
        {section === 'Keyboard' && <KeyboardPanel tab={kbTab} />}
        {section === 'Clipboard' && <ClipboardPanel />}
        {section === 'Appearance' && <AppearancePanel />}
        {section === 'Multitasking' && <MultitaskingPanel />}
        {section === 'Sound' && <SoundPanel />}
        {section === 'Notifications' && <NotificationsPanel />}
        {section === 'Power' && <PowerPanel />}
        {section === 'Printers' && <PrintersPanel />}
        {section === 'Default apps' && <DefaultAppsPanel />}
        {section === 'AI' && <AIPanel />}
        {section === 'Privacy & security' && <PrivacyPanel />}
        {section === 'Lock screen' && <LockScreenPanel onLock={() => void os.lock()} />}
        {section === 'Users' && <UsersPanel />}
        {section === 'Devices' && <><DevicesPanel onProblem={setProblem} /><DeviceExtras /></>}
        {section === 'Drivers' && <DriversPanel onOpenUpdates={() => setSection('Updates')} />}
        {section === 'Updates' && <><H1>{t('settings.nav.Updates')}</H1><UpdatesPanel /></>}
        {section === 'Managed' && <ManagedPanel />}
        {section === 'About' && <AboutPanel />}
      </main>
      {problem && <DeviceProblemDialog device={problem} onClose={() => setProblem(null)} onOpenUpdates={() => setSection('Updates')} onOpenDrivers={() => setSection('Drivers')} />}
    </div>
  )
}
