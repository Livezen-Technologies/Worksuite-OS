// Recovery screen for a setup that didn't finish (FAILED, RECOVERY_MODE, ROLLED_BACK, ROLLING_BACK). The options come
// from the service's GetRecoveryOptions (recoveryOptions()); each says what it keeps and what it changes. Rollback is
// shown only as available when a verified rollback point exists, and always asks for confirmation listing what is
// undone and what is not. Nothing here changes the system itself: every choice is an event to the setup service.
import { useEffect, useState } from 'react'
import { formatDate, t, type MessageKey } from '../../../i18n'
import { Button } from '../../ui/button'
import { Icon } from '../../Ws'
import type { RecoveryActionId } from './RecoveryManager.ts'
import type { SetupEvent, MainState } from '../core/states.ts'
import type { RecoveryView, SetupApi, SetupView } from '../../../lib/setupApi'
import InstallationLogViewer from './InstallationLogViewer'

const stepName = (s: MainState | null) => (s ? t(`sw.step.${s}` as MessageKey) : '—')

const ACTION: Record<RecoveryActionId, { label: MessageKey; keeps: MessageKey; changes: MessageKey; why?: MessageKey; icon: string }> = {
  resume: { label: 'swr.act.resume', keeps: 'swr.keep.answers', changes: 'swr.chg.resume', why: 'swr.why.resume', icon: 'M8 5v14l11-7z' },
  retry: { label: 'swr.act.retry', keeps: 'swr.keep.answers', changes: 'swr.chg.retry', why: 'swr.why.retry', icon: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4' },
  restore: { label: 'swr.act.restore', keeps: 'swr.keep.checkpoint', changes: 'swr.chg.restore', why: 'swr.why.restore', icon: 'M5 3h14v18l-7-4-7 4z' },
  rollback: { label: 'swr.act.rollback', keeps: 'swr.keep.rollbackPoint', changes: 'swr.rb.undo', why: 'swr.why.rollback', icon: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3' },
  logs: { label: 'swr.act.logs', keeps: 'swr.keep.all', changes: 'swr.chg.logs', icon: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5' },
  restart: { label: 'swr.act.restart', keeps: 'swr.keep.disk', changes: 'swr.chg.restart', icon: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5' },
  exit: { label: 'swr.act.exit', keeps: 'swr.keep.resumable', changes: 'swr.chg.exit', icon: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5' },
}

export default function RecoveryScreen({ api, view, send, busy, onExit }: { api: SetupApi; view: SetupView; send: (e: SetupEvent) => Promise<boolean>; busy?: boolean; onExit?: () => void }) {
  const [opts, setOpts] = useState<RecoveryView | null>(null)
  const [dialog, setDialog] = useState<'log' | 'rollback' | 'restore' | null>(null)

  useEffect(() => {
    let alive = true
    void api.recovery().then((r) => { if (alive && r.ok) setOpts(r.value) })
    return () => { alive = false }
  }, [api, view.state, view.checkpoints.length])

  if (view.state === 'ROLLING_BACK') return (
    <Shell><div role="status" aria-live="polite" className="flex flex-col items-center gap-4 py-10">
      <span aria-hidden className="size-10 animate-spin rounded-full border-[3px] border-[rgba(127,178,255,0.25)] border-t-[#7FB2FF] motion-reduce:animate-none" />
      <p className="m-0 text-lg font-semibold">{t('swr.rolling')}</p>
    </div></Shell>
  )

  const failedAt = opts?.failedAt ?? null
  const rolledBack = view.state === 'ROLLED_BACK'
  const pick = (id: RecoveryActionId) => {
    switch (id) {
      case 'resume': return void send({ type: 'RESUME' })
      case 'retry': return void send({ type: 'RETRY_NOW' })
      case 'restart': return void send({ type: 'RESTART_SETUP' })
      case 'logs': case 'rollback': case 'restore': return setDialog(id === 'logs' ? 'log' : id)
      case 'exit': return onExit?.()
    }
  }
  // From FAILED, the service needs RECOVERY_MODE first for retry/restore/rollback; restart works from both.
  const go = async (e: SetupEvent) => {
    if (view.state === 'FAILED' && e.type !== 'RESTART_SETUP' && !(await send({ type: 'ENTER_RECOVERY', reason: 'opened by the person' }))) return
    await send(e)
    setDialog(null)
  }
  const choose = (id: RecoveryActionId) => {
    if (view.state === 'FAILED' && (id === 'resume' || id === 'retry')) return void go({ type: id === 'retry' ? 'RETRY_NOW' : 'RESUME' })
    pick(id)
  }

  return (
    <Shell>
      <div className="flex items-start gap-4">
        <span className={`flex size-12 shrink-0 items-center justify-center rounded-2xl ${rolledBack ? 'bg-[rgba(46,158,106,0.18)] text-[#6FE0A8]' : 'bg-[rgba(217,69,43,0.18)] text-[#FF9C8A]'}`}>
          <Icon d={[rolledBack ? 'M5 12l5 5 9-10' : 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0z']} size={24} />
        </span>
        <div className="flex flex-col gap-1">
          <h1 tabIndex={-1} className="m-0 text-[28px] font-bold tracking-[-0.02em]">{rolledBack ? t('swr.rolledBack') : t('swr.title')}</h1>
          <p className="m-0 text-[15px] text-[#C9D6EE]">{rolledBack ? t('swr.rolledBackHint') : t('swr.failedAt', { step: stepName(failedAt) })}</p>
          {view.lastError && !rolledBack && <p className="m-0 text-sm break-words text-[#FFB4A6]">{t('swr.error', { error: view.lastError })}</p>}
        </div>
      </div>
      <p className="m-0 text-sm text-[#8FA3C8]">{t('swr.choose')}</p>
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2">
        {(opts?.actions ?? []).filter((a) => a.id !== 'exit' || onExit).map((a) => {
          const m = ACTION[a.id]
          const changes = a.id === 'rollback' ? (opts?.rollback.steps.map((s) => s.undo).join('; ') || '—') : t(m.changes, { step: stepName(failedAt) })
          return (
            <li key={a.id}>
              <button type="button" disabled={!a.available || busy} onClick={() => choose(a.id)} aria-describedby={`sw-act-${a.id}`}
                className="group flex h-full w-full cursor-pointer flex-col gap-2 rounded-2xl border border-[rgba(127,178,255,0.18)] bg-[rgba(10,24,56,0.6)] p-4 text-left text-[#E8EEFA] transition-colors hover:border-[rgba(127,178,255,0.45)] hover:bg-[rgba(16,36,80,0.75)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7FB2FF] disabled:cursor-default disabled:opacity-55 disabled:hover:border-[rgba(127,178,255,0.18)] disabled:hover:bg-[rgba(10,24,56,0.6)]">
                <span className="flex items-center gap-2.5 text-[15px] font-semibold">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-[rgba(31,107,255,0.18)] text-[#9CC2FF]"><Icon d={[m.icon]} size={17} /></span>
                  {t(m.label)}
                </span>
                <span id={`sw-act-${a.id}`} className="flex flex-col gap-1 text-[13px] leading-snug text-[#AFC0DD]">
                  {a.available ? <>
                    <span><b className="font-semibold text-[#C9D6EE]">{t('swr.keeps')}</b> {t(m.keeps)}</span>
                    <span><b className="font-semibold text-[#C9D6EE]">{t('swr.changes')}</b> {changes}</span>
                  </> : <span><b className="font-semibold text-[#C9D6EE]">{t('swr.unavailable')}</b> {m.why ? t(failedAt || a.id !== 'resume' ? m.why : 'swr.why.noStep') : ''}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {dialog === 'log' && <InstallationLogViewer load={(n) => api.log(n)} onClose={() => setDialog(null)} />}
      {dialog === 'rollback' && opts && (
        <Confirm title={t('swr.rb.title')} onCancel={() => setDialog(null)} confirm={t('swr.rb.confirm')} danger busy={busy} onConfirm={() => void go({ type: 'ROLLBACK' })}>
          <p className="m-0 text-sm font-semibold text-[#C9D6EE]">{t('swr.rb.undo')}</p>
          <ul className="m-0 flex flex-col gap-1 pl-5 text-sm text-[#AFC0DD]">{opts.rollback.steps.map((s) => <li key={s.state}>{stepName(s.state)}: {s.undo}</li>)}</ul>
          {opts.rollback.notUndone.length > 0 && <>
            <p className="m-0 text-sm font-semibold text-[#FFB4A6]">{t('swr.rb.notUndone')}</p>
            <ul className="m-0 flex flex-col gap-1 pl-5 text-sm text-[#AFC0DD]">{opts.rollback.notUndone.map((n) => <li key={n}>{n}</li>)}</ul>
          </>}
        </Confirm>
      )}
      {dialog === 'restore' && (
        <Confirm title={t('swr.cp.title')} onCancel={() => setDialog(null)}>
          <p className="m-0 text-sm text-[#AFC0DD]">{t('swr.chg.restore')}</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {[...view.checkpoints].reverse().map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-xl border border-[rgba(127,178,255,0.15)] px-3 py-2">
                <span className="mr-auto text-sm">{t('swr.cp.item', { step: stepName(c.state), time: formatDate(c.at) })}</span>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void go({ type: 'RESTORE_CHECKPOINT', checkpointId: c.id })}>{t('swr.cp.restore')}</Button>
              </li>
            ))}
          </ul>
        </Confirm>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto flex w-full max-w-[880px] flex-col gap-5">{children}</section>
}

function Confirm({ title, children, onCancel, onConfirm, confirm, danger, busy }: { title: string; children: React.ReactNode; onCancel: () => void; onConfirm?: () => void; confirm?: string; danger?: boolean; busy?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,18,0.7)] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
        className="ws-dark-zone flex w-full max-w-[560px] flex-col gap-3 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[#0A1838] p-6 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
        <h2 className="m-0 text-lg font-semibold">{title}</h2>
        {children}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onCancel} autoFocus>{t('swr.rb.cancel')}</Button>
          {onConfirm && confirm && <Button variant={danger ? 'danger' : 'primary'} size="md" disabled={busy} onClick={onConfirm}>{confirm}</Button>}
        </div>
      </div>
    </div>
  )
}
