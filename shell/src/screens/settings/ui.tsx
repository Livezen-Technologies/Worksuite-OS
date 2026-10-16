// Small pieces shared by the Settings sections that live in screens/settings/.
import type { ReactNode } from 'react'
import { unavailableText } from '../../lib/useSystem'
import { Empty } from '../Hardware'
import { t } from '../../i18n'

export const H1 = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 pr-10"><h1 className="m-0 text-[28px] font-bold">{children}</h1>{action}</div>
)
export const Note = ({ children }: { children: ReactNode }) => <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">{children}</p>
export const Unavail = ({ what, reason }: { what: string; reason?: string }) => <Empty title={t('settings.notAvailable', { what })}>{reason ? `${unavailableText(reason)}.` : t('settings.couldNotRead')}</Empty>

/** The boards' large toggle (50×30, 24px knob) in a given colour. */
export function BigSwitch({ label, checked, onChange, disabled, color = '#1F6BFF' }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; color?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className="relative h-[30px] w-[50px] shrink-0 cursor-pointer rounded-[15px] transition-colors disabled:cursor-default disabled:opacity-60"
      style={{ background: checked ? color : 'rgba(127,178,255,0.25)' }}>
      <span className="absolute top-[3px] h-6 w-6 rounded-full bg-white transition-all" style={{ left: checked ? 23 : 3 }} />
    </button>
  )
}

/** Mono tag (MANAGED, WIREGUARD) from the VPN boards. */
export const MonoTag = ({ children, bg, color }: { children: ReactNode; bg: string; color: string }) => (
  <span className="rounded px-1.5 py-0.5 font-mono text-[10px] font-normal" style={{ background: bg, color }}>{children}</span>
)
