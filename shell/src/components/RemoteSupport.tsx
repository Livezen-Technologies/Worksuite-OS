// Remote support (issue #19): the consent dialog and the taskbar indicator. Drawn by the shell itself, above every
// app (an app window can't draw over it or imitate its placement), from what the device agent published. Nothing is
// shared before "Allow screen sharing" or "Allow remote control"; while a session runs the indicator stays visible and
// the user can drop to view only or end it. Unattended sessions (organization policy) say so in the indicator.
//
// Issue #37: the dialog says when the organization lets the administrator record; a mid-session request for control
// (after the administrator's TOTP) asks again; the indicator has the clipboard switch (off by default) and the files
// panel, where each incoming file waits for "Save to Downloads".
import { useEffect, useState } from 'react'
import { useRemoteSupport, type RsFile, type RsSession } from '../lib/remoteSupportApi'
import { formatDecimal, useT } from '../i18n'

export function RemoteSupportPrompt({ onOpen, pollMs }: { onOpen?: (open: boolean) => void; pollMs?: number } = {}) {
  const t = useT()
  const { api, session, refresh } = useRemoteSupport(pollMs)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  const elevation = !!api && session?.state === 'active' && session.elevation === 'pending'
  const pending = !!api && (session?.state === 'pending' || elevation)
  useEffect(() => { onOpen?.(pending) }, [pending, onOpen])
  if (!api || !session || !pending) return null
  if (elevation) return <ElevationDialog api={api} session={session} refresh={refresh} />
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
        {session.record && <p className="mx-[22px] mt-3 mb-0 text-xs font-semibold text-[#FFB98A]">{t('rs.recorded')}</p>}
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

type Api = NonNullable<ReturnType<typeof useRemoteSupport>['api']>

/** Step-up: the administrator (after their TOTP) asks to switch this view-only session to control. */
function ElevationDialog({ api, session, refresh }: { api: Api; session: RsSession; refresh: () => Promise<void> }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  const answer = async (allow: boolean) => {
    if (!api.decideElevation) return
    setBusy(true); setErr(false)
    const r = await api.decideElevation(allow).catch(() => ({ ok: false as const, error: 'failed' }))
    setBusy(false)
    if (!r.ok) setErr(true)
    void refresh()
  }
  const btn = 'cursor-pointer rounded-[10px] px-4 py-2.5 text-sm font-semibold disabled:cursor-default disabled:opacity-60'
  return (
    <div className="fixed inset-0 z-[98] flex items-center justify-center font-sans text-[#E8EEFA]">
      <div className="absolute inset-0 bg-[rgba(2,6,16,0.6)] backdrop-blur-[8px]" aria-hidden="true" />
      <div role="alertdialog" aria-modal="true" aria-labelledby="rs-e-t" aria-describedby="rs-e-d" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) void answer(false) }}
        className="relative box-border w-[460px] max-w-[calc(100%-32px)] overflow-hidden rounded-[20px] border border-[rgba(255,185,138,0.35)] bg-[var(--ws-g-card,#0F2350)] shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        <div className="flex flex-col gap-2.5 px-[26px] pt-[24px] pb-[14px] text-center">
          <h2 id="rs-e-t" className="m-0 text-[19px] font-bold">{t('rs.elevTitle')}</h2>
          <p id="rs-e-d" className="m-0 text-sm leading-normal text-[#C9D6EE]">{t('rs.elevBody', { admin: session.admin_name })}</p>
          <p className="m-0 text-xs text-[#8FA3C8]">{t('rs.note')}</p>
        </div>
        {err && <p role="alert" className="mx-[22px] mt-0 mb-2 text-xs text-[#FF8A7A]">{t('rs.failed')}</p>}
        <div className="flex flex-wrap justify-end gap-2.5 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.35)] px-[18px] py-3.5">
          <button type="button" disabled={busy} onClick={() => void answer(false)} className={`${btn} border border-[rgba(127,178,255,0.25)] bg-transparent text-[#E8EEFA]`}>{t('rs.elevDeny')}</button>
          <button type="button" disabled={busy} onClick={() => void answer(true)} className={`${btn} border-0 bg-[#D9452B] text-white`}>{t('rs.elevAllow')}</button>
        </div>
      </div>
    </div>
  )
}

/** Files in this session: incoming ones wait for the user's "Save to Downloads"; the user can offer one of theirs. */
function RsFiles({ api, admin }: { api: Api; admin: string }) {
  const t = useT()
  const [files, setFiles] = useState<RsFile[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!api.files) return
    let live = true
    const tick = () => { void api.files!().then((l) => { if (live) setFiles(l) }).catch(() => {}) }
    tick()
    const id = setInterval(tick, 1000)
    return () => { live = false; clearInterval(id) }
  }, [api])
  const size = (n: number) => t('rs.mb', { n: formatDecimal(n / 1048576, 1) })
  const pct = (f: RsFile) => (f.size ? Math.floor((f.done / f.size) * 100) : 100)
  const btn = 'rounded-md px-2 py-0.5 font-semibold'
  return (
    <div role="dialog" aria-label={t('rs.files')} className="absolute right-0 bottom-10 z-50 flex w-[320px] flex-col gap-2 rounded-xl border border-[rgba(127,178,255,0.25)] bg-[#0F2350] p-3 text-xs font-normal text-[#E8EEFA] shadow-xl">
      <div aria-live="polite" className="flex max-h-[220px] flex-col gap-1.5 overflow-auto">
        {files.length === 0 && <span className="text-[#8FA3C8]">{t('rs.filesEmpty')}</span>}
        {files.map((f) => (
          <div key={f.id} className="flex flex-col gap-1">
            {f.direction === 'to_device' && f.state === 'offered' && (<>
              <span>{t('rs.fileIncoming', { admin, name: f.name, size: size(f.size) })}</span>
              <span className="flex gap-1.5">
                <button type="button" onClick={() => void api.acceptFile?.(f.id)} className={`${btn} bg-[#1F6BFF] text-white`}>{t('rs.fileAccept')}</button>
                <button type="button" onClick={() => void api.rejectFile?.(f.id)} className={`${btn} border border-[rgba(127,178,255,0.25)]`}>{t('rs.fileDecline')}</button>
              </span>
            </>)}
            {(f.state === 'receiving' || f.state === 'sending') && <span>{t('rs.fileProgress', { name: f.name, pct: pct(f) })}</span>}
            {f.state === 'done' && <span>{f.direction === 'to_device' ? t('rs.fileSaved', { name: f.saved_as ?? f.name }) : t('rs.fileProgress', { name: f.name, pct: 100 })}</span>}
            {f.state === 'offered' && f.direction === 'to_admin' && <span>{t('rs.fileOffered', { name: f.name })}</span>}
            {f.state === 'failed' && <span className="text-[#FF8A7A]">{t('rs.fileFailed', { name: f.name })}</span>}
          </div>
        ))}
      </div>
      {err && <span role="alert" className="text-[#FF8A7A]">{err}</span>}
      {api.offerFile && (
        <button type="button" onClick={() => { setErr(''); void api.offerFile!().then((r) => { if (!r.ok && r.error !== 'cancelled') setErr(t('rs.fileFailed', { name: '' })) }) }}
          className="self-start rounded-md bg-[#1F6BFF] px-2.5 py-1 font-semibold text-white">{t('rs.fileOffer')}</button>
      )}
    </div>
  )
}

/** Chat with the administrator (data channel of the session). */
function RsChat({ api }: { api: Api }) {
  const t = useT()
  const [lines, setLines] = useState<{ from: 'admin' | 'user'; text: string; at: number }[]>([])
  const [text, setText] = useState('')
  useEffect(() => {
    if (!api.chat) return
    let live = true
    const tick = () => { void api.chat!().then((l) => { if (live) setLines(l) }).catch(() => {}) }
    tick()
    const id = setInterval(tick, 1500)
    return () => { live = false; clearInterval(id) }
  }, [api])
  return (
    <div role="dialog" aria-label={t('rs.chat')} className="absolute right-0 bottom-10 z-50 flex w-[300px] flex-col gap-2 rounded-xl border border-[rgba(127,178,255,0.25)] bg-[#0F2350] p-3 text-xs font-normal text-[#E8EEFA] shadow-xl">
      <div aria-live="polite" className="flex max-h-[220px] flex-col gap-1 overflow-auto">
        {lines.length === 0 && <span className="text-[#8FA3C8]">{t('rs.chatEmpty')}</span>}
        {lines.map((l, i) => <span key={i}><b>{l.from === 'admin' ? t('rs.admin') : t('rs.you')}:</b> {l.text}</span>)}
      </div>
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; void api.sendChat?.(text).then(() => api.chat?.().then(setLines)); setText('') }}>
        <input aria-label={t('rs.chatMessage')} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1 rounded-md border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.6)] px-2 py-1 text-white" />
        <button type="submit" className="rounded-md bg-[#1F6BFF] px-2.5 py-1 font-semibold text-white">{t('rs.send')}</button>
      </form>
    </div>
  )
}

/** Taskbar indicator for as long as a session is active. */
export function RemoteSupportBadge({ pollMs }: { pollMs?: number } = {}) {
  const t = useT()
  const { api, session, refresh } = useRemoteSupport(pollMs)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<'chat' | 'files' | null>(null)
  if (!api || !session || session.state !== 'active') return null
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await fn().catch(() => {}); setBusy(false); void refresh() }
  const s: RsSession = session
  const control = s.granted_mode === 'control'
  const hint = t(s.consent === 'unattended_policy' ? 'rs.hintUnattended' : 'rs.hint', { admin: s.admin_name, org: s.org_name || '—' })
  return (
    <span role="status" title={hint} className="relative flex items-center gap-1.5 rounded-full bg-[#B3541B] py-1 pl-2.5 pr-1 text-xs font-semibold text-white">
      <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-white" />
      {control ? t('rs.activeControl') : t('rs.activeView')}
      <span className="sr-only">{hint}</span>
      {s.record && <span className="ml-1 rounded-full bg-[#7A1F10] px-2 py-0.5 text-[11px]">{t('rs.recording')}</span>}
      {control && (
        <button type="button" disabled={busy} onClick={() => void run(() => api.revokeControl())}
          className="ml-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/30 disabled:opacity-60">{t('rs.viewOnly')}</button>
      )}
      {api.chat && (
        <button type="button" aria-expanded={panel === 'chat'} onClick={() => setPanel((v) => (v === 'chat' ? null : 'chat'))}
          className="ml-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/30">{t('rs.chat')}</button>
      )}
      {api.files && (
        <button type="button" aria-expanded={panel === 'files'} onClick={() => setPanel((v) => (v === 'files' ? null : 'files'))}
          className="ml-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/30">{t('rs.files')}</button>
      )}
      {api.setClipboard && (
        <button type="button" role="switch" aria-checked={!!s.clipboard} title={t('rs.clipboardHint')} disabled={busy} onClick={() => void run(() => api.setClipboard!(!s.clipboard))}
          className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-60 ${s.clipboard ? 'bg-white/40' : 'bg-white/20 hover:bg-white/30'}`}>{t('rs.clipboard')}</button>
      )}
      {panel === 'chat' && api.chat && <RsChat api={api} />}
      {panel === 'files' && api.files && <RsFiles api={api} admin={s.admin_name} />}
      <button type="button" disabled={busy} onClick={() => void run(() => api.end())}
        className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-[#8A3A10] hover:bg-[#FFE9DA] disabled:opacity-60">{t('rs.end')}</button>
    </span>
  )
}
