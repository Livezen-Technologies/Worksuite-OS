// Settings › Managed › Kiosk mode (board KioskSettings). Kiosk mode is device policy, set by the organization in the
// WorkSuite admin console (services/server/src/kiosk.ts) and applied by the device agent, so this page shows what the
// policy makes this device do and never edits it. The exit PIN is not shown or sent here, only whether one is set.
import { Svg, card, rowLine } from '../../components/Dk'
import type { KioskSummary } from '../../lib/os'
import { formatNumber, t, type MessageKey } from '../../i18n'
import { Note } from './ui'

const TYPES: { id: KioskSummary['app']['type']; icon: string; name: MessageKey; desc: MessageKey; src: MessageKey }[] = [
  { id: 'desktop', icon: 'M4 4h16v16H4zM4 9h16', name: 'kiosk.type.app', desc: 'kiosk.type.appDesc', src: 'kiosk.src.app' },
  { id: 'url', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18', name: 'kiosk.type.web', desc: 'kiosk.type.webDesc', src: 'kiosk.src.web' },
  { id: 'module', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', name: 'kiosk.type.module', desc: 'kiosk.type.moduleDesc', src: 'kiosk.src.module' },
]

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={`flex min-h-[48px] items-center gap-4 px-4 py-2.5 ${rowLine}`}>
      <dt className="w-[150px] shrink-0 text-xs text-[#8FA3C8]">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 text-[13px] break-words">{children}</dd>
    </div>
  )
}
function Lock({ name, desc, on }: { name: string; desc: string; on: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 ${rowLine}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-px"><span className="text-[13px] font-medium">{name}</span><span className="text-[11px] text-[#8FA3C8]">{desc}</span></span>
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${on ? 'bg-[rgba(95,211,154,0.16)] text-[#5FD39A]' : 'bg-white/10 text-[#C9D6EE]'}`}>{on ? t('common.on') : t('common.off')}</span>
    </div>
  )
}

export function KioskPanel({ kiosk, org, onBack }: { kiosk: KioskSummary | null; org: string; onBack: () => void }) {
  const app = kiosk?.app
  const src = !app ? '' : app.type === 'url' ? app.url : app.id
  return <>
    <div className="flex flex-col gap-1 pr-10">
      <nav aria-label={t('kiosk.crumbs')} className="flex items-center gap-1.5 text-xs text-[#8FA3C8]">
        <button type="button" onClick={onBack} className="cursor-pointer text-[#7FB2FF] hover:underline">{t('settings.nav.Managed')}</button><span aria-hidden="true">›</span><span>{t('kiosk.title')}</span>
      </nav>
      <h1 className="m-0 text-[28px] font-bold">{t('kiosk.title')}</h1>
    </div>
    <div role="status" className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-[13px] ${kiosk ? 'border-[rgba(95,211,154,0.4)] bg-[rgba(95,211,154,0.1)]' : 'border-[rgba(127,178,255,0.15)] bg-[rgba(127,178,255,0.08)]'}`}>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${kiosk ? 'bg-[#5FD39A]' : 'bg-[#8FA3C8]'}`} />
      <span className="flex-1">{kiosk ? t('kiosk.onBanner', { org }) : t('kiosk.offBanner', { org })}</span>
      {kiosk && <span className="font-mono text-xs text-[#8FA3C8]">{t('kiosk.userTag', { user: kiosk.user })}</span>}
    </div>
    <section aria-labelledby="kiosk-runs" className="flex flex-col gap-2">
      <h2 id="kiosk-runs" className="m-0 text-sm font-semibold text-[#C9D6EE]">{t('kiosk.whatRuns')}</h2>
      <ul className="m-0 grid list-none grid-cols-3 gap-2.5 p-0">
        {TYPES.map((x) => {
          const on = x.id === app?.type
          return (
            <li key={x.id} aria-current={on ? 'true' : undefined} className={`flex flex-col gap-1.5 rounded-xl border p-3.5 ${on ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.12)]' : 'border-[rgba(127,178,255,0.15)] bg-[rgba(14,32,72,0.5)]'} ${kiosk && !on ? 'opacity-60' : ''}`}>
              <Svg d={x.icon} size={20} stroke={on ? '#7FB2FF' : '#8FA3C8'} />
              <span className="text-sm font-semibold">{t(x.name)}</span>
              <span className="text-xs leading-[1.4] text-[#8FA3C8]">{t(x.desc)}</span>
            </li>
          )
        })}
      </ul>
    </section>
    {kiosk && app ? (
      <div className="grid grid-cols-2 gap-3.5">
        <dl className={`${card} m-0 flex flex-col`}>
          <Fact label={t(TYPES.find((x) => x.id === app.type)!.src)}><span className="font-mono text-xs">{src}</span></Fact>
          {app.type === 'url' && <Fact label={t('kiosk.allowed')}>{kiosk.allowed_urls.length ? <span className="font-mono text-xs">{kiosk.allowed_urls.join(', ')}</span> : t('kiosk.allowedStart')}</Fact>}
          <Fact label={t('kiosk.idle')}>{kiosk.idle_reset_minutes ? t('kiosk.idleMin', { n: formatNumber(kiosk.idle_reset_minutes) }) : t('time.never')}</Fact>
          <Fact label={t('kiosk.orientation')}>{t(`kiosk.orient.${kiosk.orientation ?? 'landscape'}` as MessageKey)}</Fact>
          <Fact label={t('kiosk.screenOff')}>{kiosk.screen_off ? t('kiosk.screenOffRange', { from: kiosk.screen_off.from, until: kiosk.screen_off.until }) : t('time.never')}</Fact>
          <Fact label={t('kiosk.exit')}>{kiosk.exit_pin ? t('kiosk.exitPin') : t('kiosk.exitAdmin')}</Fact>
        </dl>
        <section aria-label={t('kiosk.lockdown')} className={`${card} flex flex-col`}>
          <Lock name={t('kiosk.lock.keys')} desc={t('kiosk.lock.keysDesc')} on />
          <Lock name={t('kiosk.lock.panel')} desc={t('kiosk.lock.panelDesc')} on />
          <Lock name={t('kiosk.lock.osk')} desc={t('kiosk.lock.oskDesc')} on={kiosk.show_on_screen_keyboard} />
          <Lock name={t('kiosk.lock.wipe')} desc={t('kiosk.lock.wipeDesc')} on />
          <Lock name={t('kiosk.lock.usb')} desc={t('kiosk.lock.usbDesc')} on={false} />
        </section>
      </div>
    ) : null}
    <Note>{t('kiosk.note', { org })}</Note>
  </>
}
