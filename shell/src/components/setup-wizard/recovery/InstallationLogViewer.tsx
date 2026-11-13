// The installation log (setup service GetLog), read-only: refresh, show only problem lines, copy for a support
// request. A dialog over the recovery screen; Escape closes it and focus returns to the opener.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../../i18n'
import { Button } from '../../ui/button'
import { mono } from '../../Ws'

const PROBLEM = /\b(fail(ed|ure)?|error|warn(ing)?|refused|denied|interrupted|timed? ?out)\b/i

export default function InstallationLogViewer({ load, onClose, lines = 400 }: { load: (lines: number) => Promise<{ ok: true; value: string } | { ok: false; error: string }>; onClose: () => void; lines?: number }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [problems, setProblems] = useState(false)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pre = useRef<HTMLPreElement>(null)

  const refresh = useCallback(async () => {
    const r = await load(lines)
    if (r.ok) { setText(r.value); setFailed(false) } else { setText(null); setFailed(true) }
  }, [load, lines])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    box.current?.focus()
    return () => opener?.focus?.()
  }, [])
  // Newest lines are at the bottom: keep them in view after each load.
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight }, [text, problems])

  const shown = useMemo(() => {
    const all = (text ?? '').split('\n').filter(Boolean)
    return problems ? all.filter((l) => PROBLEM.test(l)) : all
  }, [text, problems])

  const copy = async () => {
    try { await navigator.clipboard.writeText(text ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard refused */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,18,0.7)] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="sw-log-title" tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
        className="ws-dark-zone flex max-h-[85vh] w-full max-w-[900px] flex-col gap-3 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[#0A1838] p-5 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)] outline-none">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="sw-log-title" className="m-0 mr-auto text-lg font-semibold">{t('swl.title')}</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-[#C9D6EE]">
            <input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} className="size-4 accent-[#1F6BFF]" />
            {t('swl.filter')}
          </label>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('swl.refresh')}</Button>
          <Button variant="secondary" size="sm" onClick={() => void copy()} disabled={!text}>{copied ? t('swl.copied') : t('swl.copy')}</Button>
          <Button variant="primary" size="sm" onClick={onClose}>{t('swl.close')}</Button>
        </div>
        {failed ? <p role="alert" className="m-0 text-sm text-[#FF9C8A]">{t('swl.failed')}</p>
          : text !== null && shown.length === 0 ? <p className="m-0 text-sm text-[#8FA3C8]">{t('swl.empty')}</p>
          : (
            <pre ref={pre} tabIndex={0} aria-label={t('swl.title')} className={`${mono} m-0 min-h-[240px] overflow-auto rounded-xl bg-[rgba(4,10,26,0.7)] p-4 text-[12.5px] leading-relaxed whitespace-pre-wrap`}>
              {shown.map((l, i) => <div key={i} className={PROBLEM.test(l) ? 'text-[#FFB4A6]' : 'text-[#C9D6EE]'}>{l}</div>)}
            </pre>
          )}
      </div>
    </div>
  )
}
