// Small pieces shared by the Settings sections that live in screens/settings/.
import type { ReactNode } from 'react'
import { unavailableText } from '../../lib/useSystem'
import { Empty } from '../Hardware'
import { t } from '../../i18n'
import { Switch, type SwitchProps } from '../../components/Dk'

export const H1 = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 pr-10"><h1 className="m-0 text-[28px] font-bold">{children}</h1>{action}</div>
)
export const Note = ({ children }: { children: ReactNode }) => <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">{children}</p>
export const Unavail = ({ what, reason }: { what: string; reason?: string }) => <Empty title={t('settings.notAvailable', { what })}>{reason ? `${unavailableText(reason)}.` : t('settings.couldNotRead')}</Empty>

/** The boards' large toggle (50×30): the shared Settings switch (components/Dk.tsx) in its large size. */
export function BigSwitch(p: Omit<SwitchProps, 'large' | 'small'>) {
  return <Switch {...p} large />
}

/** Mono tag (MANAGED, WIREGUARD) from the VPN boards. */
export const MonoTag = ({ children, bg, color }: { children: ReactNode; bg: string; color: string }) => (
  <span className="rounded px-1.5 py-0.5 font-mono text-[10px] font-normal" style={{ background: bg, color }}>{children}</span>
)
