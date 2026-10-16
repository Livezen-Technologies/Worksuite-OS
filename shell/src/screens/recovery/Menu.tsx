// R1 Recovery menu.
import { useState } from 'react'
import { os, type RecoveryInfo } from '../../lib/os'
import { recoveryErrorText } from '../../lib/recovery'
import { Icon, mono } from '../../components/Ws'
import { Footer, Header, MonoTag, Page, RP, ring, small } from './Frame'
import { t as tr } from '../../i18n'

export type MenuTarget = 'repair' | 'snapshots' | 'reset' | 'unlock'

interface Tile { id: MenuTarget | 'usb' | 'terminal'; title: string; desc: string; icon: string; color: string; tint: string; tag?: string; recommended?: boolean; off: string | null }

export default function Menu({ info, onOpen }: { info: RecoveryInfo | null; onOpen: (t: MenuTarget) => void }) {
  const [notice, setNotice] = useState<string | null>(null)
  const f = info?.features
  const locked = info?.luks.filter((d) => !d.unlocked) ?? []
  const tiles: Tile[] = [
    { id: 'repair', title: tr('rec.menu.repair'), desc: tr('rec.menu.repairHint'), icon: RP.repair, color: '#5FD39A', tint: 'rgba(95,211,154,0.14)', tag: tr('hw.tag.recommended'), recommended: true, off: null },
    { id: 'snapshots', title: tr('rec.menu.snapshot'), desc: tr('rec.menu.snapshotHint'), icon: RP.snapshot, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)', off: null },
    { id: 'reset', title: tr('rec.menu.reinstall'), desc: tr('rec.menu.reinstallHint'), icon: RP.reinstall, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)', off: null },
    { id: 'unlock', title: tr('rec.menu.unlock'), desc: tr('rec.menu.unlockHint'), icon: RP.lock, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)',
      off: !info ? null : !info.luks.length ? tr('rec.menu.noLuks') : !locked.length ? tr('rec.menu.unlocked') : !f?.unlock ? tr('rec.menu.noUnlock') : null },
    { id: 'usb', title: tr('rec.menu.usb'), desc: tr('rec.menu.usbHint'), icon: RP.usb, color: '#7FB2FF', tint: 'rgba(31,107,255,0.18)', off: f && !f.copy_usb ? tr('rec.menu.notYet') : null },
    { id: 'terminal', title: tr('rec.menu.terminal'), desc: tr('rec.menu.terminalHint'), icon: RP.terminal, color: '#8FA3C8', tint: 'rgba(127,178,255,0.1)', off: f && !f.terminal ? tr('rec.menu.notYet') : null },
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
  const manual = !!info?.manual && !failures
  const facts = [info?.os_version, info?.disk, info?.firmware].filter(Boolean).join(' · ')

  return (
    <Page label={tr('rec.menu.label')}>
      <Header logo right={facts ? <span className={`${mono} text-xs text-[#8FA3C8]`}>{facts}</span> : null} />
      <div className="flex flex-col gap-7 px-[120px] pb-24 pt-11 max-[900px]:px-6">
        <div className="flex flex-col gap-2">
          {/* Chosen in the boot menu: a neutral heading, nothing "went wrong". */}
          <h1 className="m-0 text-[32px] font-bold tracking-[-0.02em]">{manual ? tr('rec.menu.titleManual') : tr('rec.menu.title')}</h1>
          <p className="m-0 text-[15px] text-[#8FA3C8]">
            {manual ? tr('rec.menu.chooseManual') : <>{failures ? tr('rec.menu.failures', { count: failures }) : tr('rec.menu.failed')} {tr('rec.menu.choose')}</>}
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
                {t.off && <span id={`off-${t.id}`} className="text-xs text-[#8FA3C8]">{t.off}</span>}
              </span>
            </button>
          ))}
        </div>
        {notice && <p role="status" className="m-0 text-[13px] text-[#C9D6EE]">{notice}</p>}
      </div>
      <Footer className="h-16 gap-7 px-10 text-[13px] text-[#8FA3C8]">
        {/* No network bridge exists in recovery yet, so Wi-Fi is shown but can't be used. */}
        <button type="button" disabled title={tr('rec.menu.noWifi')} className={`flex items-center gap-2 text-[#8FA3C8] ${ring} rounded-sm`}>
          <Icon d={[RP.wifi]} size={16} stroke="#8FA3C8" />{tr('rec.menu.wifi')}
        </button>
        <span lang="en-US">English (US)</span>
        <span className="ml-auto" />
        <button type="button" onClick={() => void os.power('restart')} className={small}>{tr('power.restart')}</button>
        <button type="button" onClick={() => void os.power('shutdown')} className={small}>{tr('power.shutDown')}</button>
      </Footer>
    </Page>
  )
}
