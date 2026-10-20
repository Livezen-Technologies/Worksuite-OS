// Settings › About › Diagnostics, for administrators only (members of sudo/admin/wheel; the system journal and boot
// settings also need polkit's lk.worksuite.diagnostics, i.e. an administrator's password). Everything the splash,
// the greeter and the shell keep off the screen is in the journal; this is where administrators read it:
// - this session's journal (no password), this and the previous start-up, the sign-in screen (password);
// - an export bundle through the existing problem report (every section, saved to a file);
// - "Show boot details": a start-up menu entry without the splash, every status line on screen (Esc on the splash
//   shows them once, too).
import { useEffect, useState } from 'react'
import { os } from '../../lib/os'
import { errorMessage } from '../../lib/errors'
import { sessionApi, useIsAdmin } from '../../lib/sessionApi'
import { Switch, btnGhost, btnPrimary, card } from '../../components/Dk'
import { t, type MessageKey } from '../../i18n'

type Log = 'session' | 'boot' | 'previous' | 'greeter'
const LOGS: [Log, MessageKey][] = [['session', 'diag.log.session'], ['boot', 'diag.log.boot'], ['previous', 'diag.log.previous'], ['greeter', 'diag.log.greeter']]
const LINES = 400

export function Diagnostics() {
  const admin = useIsAdmin()
  const [log, setLog] = useState<Log>('session')
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [details, setDetails] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!admin) return
    void sessionApi.bootDetails('status').then((r) => { if (r.ok) setDetails(r.value) }).catch(() => {})
  }, [admin])
  if (!admin) return null

  const show = async () => {
    setBusy('log'); setMsg(null); setCopied(false)
    const r = log === 'session' ? await sessionApi.sessionJournal(LINES) : await sessionApi.systemJournal(log, LINES)
    setBusy(null)
    if (r.ok) setText(r.value.trim() || t('diag.empty'))
    else { setText(null); const m = errorMessage(r.error); if (m) setMsg({ text: m, error: true }) }
  }
  const exportBundle = async () => {
    setBusy('export'); setMsg(null)
    const c = await os.reportCollect().catch(() => ({ ok: false as const, error: 'failed' }))
    if (!c.ok) { setBusy(null); setMsg({ text: errorMessage(c.error), error: true }); return }
    const ids = c.value.sections.filter((s) => s.available).map((s) => s.id)
    const r = await os.reportSave(c.value.id, ids, t('diag.bundleNote')).catch(() => ({ ok: false as const, error: 'failed' }))
    setBusy(null)
    if (r.ok) setMsg({ text: t('report.saved', { path: r.value }) })
    else { const m = errorMessage(r.error); if (m) setMsg({ text: m, error: true }) }
  }
  const toggleDetails = async (on: boolean) => {
    setBusy('details'); setMsg(null)
    const r = await sessionApi.bootDetails(on ? 'on' : 'off')
    setBusy(null)
    if (r.ok) setDetails(r.value)
    else { const m = errorMessage(r.error); if (m) setMsg({ text: m, error: true }) }
  }

  return (
    <section aria-labelledby="ws-diag-h" className={`${card} flex flex-col gap-3 px-[18px] py-4`}>
      <div className="flex flex-col gap-1">
        <h2 id="ws-diag-h" className="m-0 flex items-center gap-2 text-[15px] font-semibold">{t('diag.title')}<span className="rounded-full bg-[rgba(185,160,255,0.16)] px-2 py-0.5 text-[11px] font-medium text-[#B9A0FF]">{t('diag.adminOnly')}</span></h2>
        <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">{t('diag.intro')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t('diag.which')} className="flex flex-wrap gap-1.5">
          {LOGS.map(([id, key]) => (
            <button key={id} type="button" role="radio" aria-checked={log === id} onClick={() => { setLog(id); setText(null) }}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs ${log === id ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.25)] text-white' : 'border-[rgba(127,178,255,0.2)] text-[#C9D6EE] hover:bg-white/[0.05]'}`}>{t(key)}</button>
          ))}
        </div>
        <button type="button" disabled={!!busy} onClick={() => void show()} className={`${btnPrimary} ml-auto !px-3.5 !py-2 text-[13px]`}>{busy === 'log' ? t('diag.loading') : t('diag.show')}</button>
      </div>
      {log !== 'session' && !text && <p className="m-0 text-xs text-[#8FA3C8]">{t('diag.needsPassword')}</p>}
      {text && <>
        <pre aria-label={t(LOGS.find((l) => l[0] === log)![1])} className="m-0 max-h-[320px] overflow-auto rounded-lg bg-black/30 p-2.5 font-mono text-[11px] whitespace-pre-wrap break-all text-[#C9D6EE]">{text}</pre>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {}) }} className={`${btnGhost} self-start !px-3 !py-1.5 text-xs`}>{copied ? t('err.copied') : t('diag.copy')}</button>
      </>}
      <div className="flex items-center gap-3 border-t border-[rgba(127,178,255,0.1)] pt-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('diag.bundle')}</span><span className="text-xs text-[#8FA3C8]">{t('diag.bundleSub')}</span></span>
        <button type="button" disabled={!!busy} onClick={() => void exportBundle()} className={`${btnGhost} !px-3.5 !py-2 text-[13px]`}>{busy === 'export' ? t('diag.exporting') : t('diag.export')}</button>
      </div>
      <div className="flex items-center gap-3 border-t border-[rgba(127,178,255,0.1)] pt-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('diag.bootDetails')}</span><span className="text-xs text-[#8FA3C8]">{t('diag.bootDetailsSub')}</span></span>
        <Switch label={t('diag.bootDetails')} checked={!!details} disabled={details === null} loading={!!busy} onChange={(v) => toggleDetails(v)} />
      </div>
      {msg && <p role={msg.error ? 'alert' : 'status'} className={`m-0 text-[13px] ${msg.error ? 'text-[#FCA5A5]' : 'text-[#86EFAC]'}`}>{msg.text}</p>}
    </section>
  )
}
