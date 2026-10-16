// "X quit unexpectedly" (H6Problem board's shape): an app the person opened crashed (systemd-coredump, see
// electron/sessionHost.ts). Reopen starts it again in its own scope; Report… opens Settings › About › Report a
// problem. What crashed and how (signal, executable) is in the administrator details only.
import { useEffect, useRef, useState } from 'react'
import { sessionApi, type Crash } from '../lib/sessionApi'
import { ErrorDetails } from './ErrorDetails'
import { t } from '../i18n'

export function CrashDialog({ onReport }: { onReport: () => void }) {
  const [queue, setQueue] = useState<Crash[]>([])
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => sessionApi.onCrash((c) => setQueue((q) => (q.some((x) => (x.appId ?? x.name) === (c.appId ?? c.name)) ? q : [...q, c]))), [])
  const c = queue[0]
  useEffect(() => { if (c) first.current?.focus() }, [c])
  if (!c) return null
  const next = () => setQueue((q) => q.slice(1))
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(2,6,16,0.45)] p-4 font-sans">
      <div role="alertdialog" aria-modal="true" aria-labelledby="crash-t" aria-describedby="crash-d"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); next() } }}
        className="flex w-[460px] max-w-full flex-col gap-4 rounded-[20px] border border-[rgba(127,178,255,0.18)] bg-[#0C1E46] p-7 text-[#E8EEFA] shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-[rgba(255,159,90,0.14)]" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFB98A" strokeWidth="2" strokeLinecap="round"><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 id="crash-t" className="m-0 text-xl font-bold">{t('crash.title', { app: c.name })}</h2>
            <p id="crash-d" className="m-0 text-sm text-[#C9D6EE]">{t('crash.body')}</p>
          </div>
        </div>
        <ErrorDetails details={c.details} />
        <div className="flex justify-end gap-3">
          <button ref={first} type="button" onClick={next} className="cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-4 py-2.5 text-sm font-medium hover:bg-white/5">{t('crash.ignore')}</button>
          <button type="button" onClick={() => { next(); onReport() }} className="cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.25)] px-4 py-2.5 text-sm font-medium hover:bg-white/5">{t('crash.report')}</button>
          {c.appId && <button type="button" onClick={() => { void sessionApi.reopen(c.appId!); next() }} className="cursor-pointer rounded-[10px] bg-[#1F6BFF] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110">{t('crash.reopen')}</button>}
        </div>
      </div>
    </div>
  )
}
