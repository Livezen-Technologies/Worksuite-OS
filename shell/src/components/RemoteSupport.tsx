// Remote support (issue #19): the consent dialog and the taskbar indicator. Drawn by the shell itself, above every
// app (an app window can't draw over it or imitate its placement), from what the device agent published. Nothing is
// shared before "Allow screen sharing" or "Allow remote control"; while a session runs the indicator stays visible and
// the user can drop to view only or end it. Unattended sessions (organization policy) say so in the indicator.
import { useEffect, useState } from 'react'
import { useRemoteSupport, type RsSession } from '../lib/remoteSupportApi'
import { useT } from '../i18n'

export function RemoteSupportPrompt({ onOpen, pollMs }: { onOpen?: (open: boolean) => void; pollMs?: number } = {}) {
  const t = useT()
  const { api, session, refresh } = useRemoteSupport(pollMs)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  const pending = !!api && session?.state === 'pending'
  useEffect(() => { onOpen?.(pending) }, [pending, onOpen])
  if (!api || !session || !pending) return null
  const answer = async (d: 'deny' | 'view' | 'control') => {
    setBusy(true); setErr(false)
    const r = await api.decide(d).catch(() => ({ ok: false as const, error: 'failed' }))
    setBusy(false)
    if (!r.ok) setErr(true)
    void refresh()
  }
  const row = (k: string, v: string) => (
    <div className="flex gap-3 text-[13px]"><dt className="w-[150px] shrink-0 text-[#8FA3C8]">{k}</dt><dd className="m-0 min-w-0 break-words">{v}</dd></div>
  )
  const btn = 'cursor-pointer rounded-[10px] px-4 py-2.5 text-sm font-semibold disabled:cursor-default disabled:opacity-60'
  return (
    <div className="fixed inset-0 z-[98] flex items-center justify-center font-sans text-[#E8EEFA]">
      <div className="absolute inset-0 bg-[rgba(2,6,16,0.6)] backdrop-blur-[8px]" aria-hidden="true" />
      <div role="alertdialog" aria-modal="true" aria-labelledby="rs-t" aria-describedby="rs-d" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) void answer('deny') }}
        className="relative box-border w-[500px] max-w-[calc(100%-32px)] overflow-hidden rounded-[20px] border border-[rgba(255,185,138,0.35)] bg-[var(--ws-g-card,#0F2350)] shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        <div className="flex flex-col items-center gap-2.5 px-[26px] pt-[26px] pb-[14px] text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[rgba(255,159,90,0.16)]" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FFB98A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h18v12H3zM8 20h8M12 16v4" /></svg>
          </span>
          <h2 id="rs-t" className="mt-1 mb-0 text-[19px] font-bold">{t('rs.title')}</h2>
          <p id="rs-d" className="m-0 text-sm leading-normal text-[#C9D6EE]">{t('rs.body')}</p>
        </div>
        <dl className="mx-[22px] my-0 flex flex-col gap-1.5 rounded-xl bg-[rgba(4,10,26,0.5)] px-3.5 py-3">
          {row(t('rs.admin'), session.admin_name)}
          {row(t('rs.org'), session.org_name || '—')}
          {row(t('rs.level'), session.mode === 'control' ? t('rs.levelControl') : t('rs.levelView'))}
          {row(t('rs.reason'), session.reason)}
          {row(t('rs.sessionId'), session.session_id)}
        </dl>
        <p className="mx-[22px] mt-3 mb-0 text-xs text-[#8FA3C8]">{t('rs.note')}</p>
        {err && <p role="alert" className="mx-[22px] mt-2 mb-0 text-xs text-[#FF8A7A]">{t('rs.failed')}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2.5 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.35)] px-[18px] py-3.5">
          <button type="button" disabled={busy} onClick={() => void answer('deny')} className={`${btn} border border-[rgba(127,178,255,0.25)] bg-transparent text-[#E8EEFA]`}>{t('rs.deny')}</button>
          <button type="button" disabled={busy} onClick={() => void answer('view')} className={`${btn} border-0 bg-[#1F6BFF] text-white`}>{t('rs.allowView')}</button>
          {session.mode === 'control' && (
            <button type="button" disabled={busy} onClick={() => void answer('control')} className={`${btn} border-0 bg-[#D9452B] text-white`}>{t('rs.allowControl')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Taskbar indicator for as long as a session is active. */
export function RemoteSupportBadge({ pollMs }: { pollMs?: number } = {}) {
  const t = useT()
  const { api, session, refresh } = useRemoteSupport(pollMs)
  const [busy, setBusy] = useState(false)
  if (!api || !session || session.state !== 'active') return null
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await fn().catch(() => {}); setBusy(false); void refresh() }
  const s: RsSession = session
  const control = s.granted_mode === 'control'
  const hint = t(s.consent === 'unattended_policy' ? 'rs.hintUnattended' : 'rs.hint', { admin: s.admin_name, org: s.org_name || '—' })
  return (
    <span role="status" title={hint} className="flex items-center gap-1.5 rounded-full bg-[#B3541B] py-1 pl-2.5 pr-1 text-xs font-semibold text-white">
      <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-white" />
      {control ? t('rs.activeControl') : t('rs.activeView')}
      <span className="sr-only">{hint}</span>
      {control && (
        <button type="button" disabled={busy} onClick={() => void run(() => api.revokeControl())}
          className="ml-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/30 disabled:opacity-60">{t('rs.viewOnly')}</button>
      )}
      <button type="button" disabled={busy} onClick={() => void run(() => api.end())}
        className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-[#8A3A10] hover:bg-[#FFE9DA] disabled:opacity-60">{t('rs.end')}</button>
    </span>
  )
}
