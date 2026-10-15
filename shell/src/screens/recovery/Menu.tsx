// R1 Recovery menu.
import { useState } from 'react'
import { os, type RecoveryInfo } from '../../lib/os'
import { recoveryErrorText } from '../../lib/recovery'
import { Icon, mono } from '../../components/Ws'
import { Footer, Header, MonoTag, Page, RP, ring, small } from './Frame'

export type MenuTarget = 'repair' | 'snapshots' | 'reset' | 'unlock'

interface Tile { id: MenuTarget | 'usb' | 'terminal'; title: string; desc: string; icon: string; color: string; tint: string; tag?: string; recommended?: boolean; off: string | null }

export default function Menu({ info, onOpen }: { info: RecoveryInfo | null; onOpen: (t: MenuTarget) => void }) {
  const [notice, setNotice] = useState<string | null>(null)
  const f = info?.features
  const locked = info?.luks.filter((d) => !d.unlocked) ?? []
  const tiles: Tile[] = [
    { id: 'repair', title: 'Startup repair', desc: 'Automatically find and fix problems that stop WorkSuite OS from starting.', icon: RP.repair, color: '#5FD39A', tint: 'rgba(95,211,154,0.14)', tag: 'RECOMMENDED', recommended: true, off: null },
    { id: 'snapshots', title: 'Restore a snapshot', desc: 'Go back to how the system was before a recent update. Files stay.', icon: RP.snapshot, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)', off: null },
    { id: 'reset', title: 'Reinstall WorkSuite OS', desc: 'Fresh system files. Choose whether to keep your files.', icon: RP.reinstall, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)', off: null },
    { id: 'unlock', title: 'Unlock disk with recovery key', desc: 'Use if you forgot your disk passphrase.', icon: RP.lock, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)',
      off: !info ? null : !info.luks.length ? 'No encrypted disk was found.' : !locked.length ? 'Your disk is already unlocked.' : !f?.unlock ? 'Disk unlocking isn’t available in this version.' : null },
    { id: 'usb', title: 'Copy files to USB', desc: 'Back up your files before making changes.', icon: RP.usb, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)', off: f && !f.copy_usb ? 'Not available in this version yet.' : null },
    { id: 'terminal', title: 'Terminal', desc: 'Advanced: a root shell for manual repair.', icon: RP.terminal, color: '#8FA3C8', tint: 'rgba(127,178,255,0.1)', off: f && !f.terminal ? 'Not available in this version yet.' : null },
  ]

  const pick = async (t: Tile) => {
    setNotice(null)
    if (t.id === 'usb' || t.id === 'terminal') {
      const r = t.id === 'usb' ? await os.recoveryCopyToUsb() : await os.recoveryTerminal()
      if (!r.ok) setNotice(recoveryErrorText(r.error))
      return
    }
    onOpen(t.id)
  }

  const failures = info?.failures
  const facts = [info?.os_version, info?.disk, info?.firmware].filter(Boolean).join(' · ')

  return (
    <Page label="Recovery menu">
      <Header logo right={facts ? <span className={`${mono} text-xs text-[#5E739C]`}>{facts}</span> : null} />
      <div className="flex flex-col gap-7 px-[120px] pb-24 pt-11 max-[900px]:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[32px] font-bold tracking-[-0.02em]">Something went wrong at startup</h1>
          <p className="m-0 text-[15px] text-[#8FA3C8]">
            {failures ? `WorkSuite OS didn't start correctly ${failures} time${failures === 1 ? '' : 's'} in a row.` : "WorkSuite OS didn't start correctly."} Choose how you'd like to fix it.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1">
          {tiles.map((t) => (
            <button key={t.id} type="button" disabled={!!t.off} aria-describedby={t.off ? `off-${t.id}` : undefined} onClick={() => void pick(t)}
              className={`flex cursor-pointer gap-4 rounded-[14px] border px-5 py-[18px] text-left text-[#E8EEFA] transition-colors disabled:cursor-default ${ring} ${t.recommended ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.12)] hover:bg-[rgba(31,107,255,0.2)]' : 'border-[rgba(127,178,255,0.14)] bg-[rgba(14,32,72,0.55)] hover:bg-[rgba(20,44,96,0.7)] disabled:hover:bg-[rgba(14,32,72,0.55)]'}`}>
              <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${t.off ? 'opacity-50' : ''}`} style={{ background: t.tint }}>
                <Icon d={[t.icon]} size={22} stroke={t.color} />
              </span>
              <span className="flex flex-1 flex-col gap-1">
                <span className={`flex items-center gap-2 text-base font-semibold ${t.off ? 'text-[#8FA3C8]' : ''}`}>{t.title}{t.tag && <MonoTag>{t.tag}</MonoTag>}</span>
                <span className="text-[13px] leading-[1.45] text-[#8FA3C8]">{t.desc}</span>
                {t.off && <span id={`off-${t.id}`} className="text-xs text-[#5E739C]">{t.off}</span>}
              </span>
            </button>
          ))}
        </div>
        {notice && <p role="status" className="m-0 text-[13px] text-[#C9D6EE]">{notice}</p>}
      </div>
      <Footer className="h-16 gap-7 px-10 text-[13px] text-[#8FA3C8]">
        {/* No network bridge exists in recovery yet, so Wi-Fi is shown but can't be used. */}
        <button type="button" disabled title="Wi-Fi setup isn’t available in recovery yet" className={`flex items-center gap-2 text-[#5E739C] ${ring} rounded-sm`}>
          <Icon d={[RP.wifi]} size={16} stroke="#5E739C" />Connect to Wi-Fi
        </button>
        <span lang="en-US">English (US)</span>
        <span className="ml-auto" />
        <button type="button" onClick={() => void os.power('restart')} className={small}>Restart</button>
        <button type="button" onClick={() => void os.power('shutdown')} className={small}>Shut down</button>
      </Footer>
    </Page>
  )
}
