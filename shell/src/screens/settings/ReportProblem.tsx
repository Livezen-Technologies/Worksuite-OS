// §11.6-d Report a problem (Settings › About): collect a diagnostic report, show every section for review, let the
// person leave sections out and describe the problem, then save it to a file or send it to their organization.
// Nothing is read before they press Collect, and nothing leaves the computer before they press Send.
import { useState } from 'react'
import { os, type ProblemReport, type ReportSectionId } from '../../lib/os'
import { t, type MessageKey } from '../../i18n'

const LABEL: Record<ReportSectionId, MessageKey> = {
  system: 'report.sec.system', services: 'report.sec.services', session_services: 'report.sec.sessionServices',
  session_log: 'report.sec.sessionLog', system_log: 'report.sec.systemLog', packages: 'report.sec.packages',
}

function errorText(code: string): string {
  switch (code) {
    case 'not_signed_in': return t('report.err.signedOut')
    case 'auth_required': return t('report.err.auth')
    case 'offline': return t('report.err.offline')
    case 'cancelled': return ''
    case 'service_unavailable': return t('report.err.unavailable')
    default: return t('report.err.failed')
  }
}

const btn = 'cursor-pointer rounded-[9px] px-3.5 py-[9px] text-[13px] font-semibold disabled:cursor-default disabled:opacity-60'

export function ReportProblem() {
  const [report, setReport] = useState<ProblemReport | null>(null)
  const [keep, setKeep] = useState<Set<ReportSectionId>>(new Set())
  const [open, setOpen] = useState<ReportSectionId | null>(null)
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState<'collect' | 'save' | 'send' | null>(null)
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)

  const collect = async () => {
    setBusy('collect'); setMsg(null)
    const r = await os.reportCollect().catch(() => ({ ok: false as const, error: 'failed' }))
    setBusy(null)
    if (!r.ok) { setMsg({ text: errorText(r.error), error: true }); return }
    setReport(r.value)
    setKeep(new Set(r.value.sections.filter((s) => s.available).map((s) => s.id)))
  }
  const finish = async (how: 'save' | 'send') => {
    if (!report) return
    setBusy(how); setMsg(null)
    const ids = [...keep]
    const r = await (how === 'save' ? os.reportSave(report.id, ids, desc) : os.reportSend(report.id, ids, desc)).catch(() => ({ ok: false as const, error: 'failed' }))
    setBusy(null)
    if (r.ok) setMsg({ text: how === 'save' ? t('report.saved', { path: r.value }) : t('report.sent', { id: r.value.slice(0, 8) }) })
    else if (errorText(r.error)) setMsg({ text: errorText(r.error), error: true })
  }
  const toggle = (id: ReportSectionId) => setKeep((k) => { const n = new Set(k); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <section aria-labelledby="ws-report-h" className="flex flex-col gap-3 rounded-[14px] border border-[rgba(127,178,255,0.18)] bg-[rgba(10,26,56,0.55)] px-[18px] py-4">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="ws-report-h" className="m-0 text-[15px] font-semibold">{t('report.title')}</h2>
          <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">{report ? t('report.reviewHint') : t('report.intro')}</p>
        </div>
        {!report && <button type="button" disabled={busy === 'collect'} onClick={() => void collect()} className={`${btn} bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{busy === 'collect' ? t('report.collecting') : t('report.collect')}</button>}
      </div>
      {report && <>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {report.sections.map((s) => (
            <li key={s.id} className="rounded-[10px] bg-white/[0.04] px-3 py-2">
              <div className="flex items-center gap-3">
                <label className="flex flex-1 cursor-pointer items-center gap-2.5 text-[13px]">
                  <input type="checkbox" checked={keep.has(s.id)} disabled={!s.available} onChange={() => toggle(s.id)} />
                  <span>{t(LABEL[s.id])}</span>
                  {!s.available && <span className="text-xs text-[#8FA3C8]">{t('report.notAvailable')}</span>}
                </label>
                {s.available && <button type="button" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)} className="cursor-pointer text-xs text-[#7FB2FF] hover:underline">{open === s.id ? t('report.hide') : t('report.show')}</button>}
              </div>
              {open === s.id && <pre aria-label={t(LABEL[s.id])} className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 p-2.5 font-mono text-[11px] text-[#C9D6EE]">{s.text}</pre>}
            </li>
          ))}
        </ul>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span>{t('report.describe')}</span>
          <textarea value={desc} maxLength={2000} rows={3} onChange={(e) => setDesc(e.target.value)} className="rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-black/20 p-2.5 text-[13px] text-white" />
        </label>
        <p className="m-0 text-xs text-[#8FA3C8]">{t('report.redacted')}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => { setReport(null); setMsg(null); setDesc('') }} className={`${btn} border border-white/25 text-white hover:bg-white/[0.06]`}>{t('report.discard')}</button>
          <button type="button" disabled={!!busy || keep.size === 0} onClick={() => void finish('save')} className={`${btn} border border-white/25 text-white hover:bg-white/[0.06]`}>{busy === 'save' ? t('report.saving') : t('report.save')}</button>
          <button type="button" disabled={!!busy || keep.size === 0} onClick={() => void finish('send')} className={`${btn} bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{busy === 'send' ? t('report.sending') : t('report.send')}</button>
        </div>
      </>}
      {msg && <p role={msg.error ? 'alert' : 'status'} className={`m-0 text-[13px] ${msg.error ? 'text-[#FCA5A5]' : 'text-[#86EFAC]'}`}>{msg.text}</p>}
    </section>
  )
}
