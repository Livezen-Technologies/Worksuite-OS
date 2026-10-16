// G12 "Shell restarted, apps kept": shown once after systemd restarted worksuite-shell.service. The restart count and
// the apps still running come from electron/desktopHost.ts (NRestarts, app-worksuite-*.scope units). Without the
// bridge (browser preview) nothing is shown.
import { useEffect, useState } from 'react'
import { desktopApi, type ShellRestart } from '../lib/desktopApi'
import { formatNumber, t } from '../i18n'

export function restartBody(apps: number | null): string {
  if (apps == null) return t('shellRestart.appsUnknown')
  if (apps === 0) return t('shellRestart.appsNone')
  if (apps === 1) return t('shellRestart.appsOne')
  return t('shellRestart.apps', { count: formatNumber(apps) })
}

export default function ShellRestartNotice() {
  const [info, setInfo] = useState<ShellRestart | null>(null)
  const [report, setReport] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void desktopApi?.shellRestart?.().then((r) => { if (live && r.restarted) setInfo(r) }).catch(() => {})
    return () => { live = false }
  }, [])
  if (!info || !desktopApi) return null
  const api = desktopApi
  const dismiss = () => { if (info.restarts != null) void api.shellRestartSeen?.(info.restarts); setInfo(null) }
  const send = async () => {
    setBusy(true)
    const r = await api.problemReport().catch(() => ({ ok: false as const, error: 'failed' }))
    setBusy(false)
    setReport(r.ok ? { ok: true, text: t('safe.reportSaved', { file: r.value }) } : { ok: false, text: t('safe.reportFailed') })
  }
  return (
    <div role="status" className="absolute top-6 left-1/2 z-40 box-border flex w-[560px] max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3.5 rounded-2xl border border-[rgba(95,211,154,0.4)] bg-[rgba(10,24,56,0.97)] px-[18px] py-4 font-sans text-[#E8EEFA] shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
      <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-[rgba(95,211,154,0.14)]">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#5FD39A" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" /></svg>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-sm font-semibold">{t('shellRestart.title')}</span>
        <span className="text-[13px] text-[#C9D6EE]">{report ? report.text : restartBody(info.apps)}</span>
      </span>
      {!report?.ok && (
        <button type="button" disabled={busy} onClick={() => void send()} className="cursor-pointer rounded-lg border border-[rgba(127,178,255,0.25)] px-3 py-2 text-xs text-[#E8EEFA] hover:bg-white/[0.06] disabled:opacity-50">{t('shellRestart.report')}</button>
      )}
      <button type="button" aria-label={t('common.dismiss')} onClick={dismiss} className="cursor-pointer px-1 text-lg leading-none text-[#8FA3C8] hover:text-white">×</button>
    </div>
  )
}
