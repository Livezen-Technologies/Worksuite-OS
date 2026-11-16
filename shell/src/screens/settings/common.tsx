// Settings building blocks shared by the panels: bridge answers, headings, rows, notes (from Settings.tsx).
import { type ReactNode } from 'react'
import { type Avail } from '../../lib/os'
import { unavailableText, useSystem } from '../../lib/useSystem'
import { card, rowLine } from '../../components/Dk'
import { Empty } from '../Hardware'
import { t } from '../../i18n'

type Res<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'unavailable'; reason: string }
/** Bridge answer (Avail) → loading / ok / unavailable, with optional polling (same hook as lib/useSystem). */
export function useAvail<T>(load: () => Promise<Avail<T>>, pollMs?: number, live?: 'network' | 'bluetooth' | 'battery'): { r: Res<T>; reload: () => Promise<void> } {
  const { state, reload } = useSystem(load, pollMs, live)
  const r: Res<T> = !state ? { state: 'loading' } : state.available ? { state: 'ok', value: state.value } : { state: 'unavailable', reason: state.reason }
  return { r, reload: async () => { await reload() } }
}

export const H1 = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 pr-10"><h1 className="m-0 text-[28px] font-bold">{children}</h1>{action}</div>
)
export function Rows({ rows }: { rows: { k: ReactNode; d?: ReactNode; v: ReactNode }[] }) {
  return (
    <div className={`${card} overflow-hidden`}>
      {rows.map((r, i) => (
        <div key={i} className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
          <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{r.k}</span>{r.d && <span className="text-xs text-[#8FA3C8]">{r.d}</span>}</span>
          <span className="text-[13px] text-[#C9D6EE]">{r.v}</span>
        </div>
      ))}
    </div>
  )
}
/** The boards' select look, read-only: shows the real value or "Unavailable". */
export const Value = ({ children, min = 180 }: { children: ReactNode; min?: number }) => (
  <span className="box-border flex justify-between gap-3 rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 py-[9px] text-[13px]" style={{ minWidth: min }}>
    {children ?? <span className="text-[#8FA3C8]">{t('common.unavailable')}</span>}
  </span>
)
export const Unavail = ({ what, reason }: { what: string; reason?: string }) => <Empty title={t('settings.notAvailable', { what })}>{reason ? `${unavailableText(reason)}.` : t('settings.couldNotRead')}</Empty>
export const Note = ({ children }: { children: ReactNode }) => <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">{children}</p>
