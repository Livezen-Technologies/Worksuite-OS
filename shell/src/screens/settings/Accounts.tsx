// Settings › Accounts: WorkSuite cloud sign-ins (from Settings.tsx).
import { useEffect, useState, type ReactNode } from 'react'
import { cloudErrorText, os, type CloudAccount, type SignOutChoice } from '../../lib/os'
import { takeCloudSignIn } from '../../lib/settingsNav'
import { CloudSignIn } from './CloudSignIn'
import { C, Dialog, btnGhost, btnPrimary, chip, dialogFooter, linkBtn, rowLine } from '../../components/Dk'
import { formatNumber, t } from '../../i18n'


/**
 * WorkSuite cloud sign-ins held by the credentials broker (#46): status of each account, sign in (browser OIDC + PKCE),
 * sign in again when the refresh token was refused, and sign-out, which drops the keyring entry and revokes it.
 */
export function CloudAccounts() {
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<{ account: CloudAccount; unsent: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const [again, setAgain] = useState<CloudAccount | null>(null)
  const [autoStart] = useState(takeCloudSignIn)
  const load = () => os.cloudAccounts().then((r) => { if (r.ok) { setAccounts(r.value); setError(null) } else setError(cloudErrorText(r.error)) })
  useEffect(() => { void load() }, [])
  const finish = async (a: CloudAccount, choice: SignOutChoice) => {
    const r = await os.cloudSignOut(a.id, choice)
    setPrompt(null)
    if (!r.ok) { setError(cloudErrorText(r.error)); return }
    setNotice(r.value.exported ? t('settings.acct.signedOutSaved', { path: r.value.exported }) : t('settings.acct.signedOutDone'))
    void load()
  }
  // WSOS-SYN-008: never sign out silently over unsent changes.
  const signOut = async (a: CloudAccount) => {
    setError(null); setNotice(null)
    const r = await os.syncUnsent(a.id)
    if (!r.ok) { setError(cloudErrorText(r.error)); return }
    if (r.value === 0) return finish(a, 'none')
    setPrompt({ account: a, unsent: r.value })
  }
  const signedIn = (a: CloudAccount) => { setAdding(false); setAgain(null); setError(null); setNotice(t('settings.acct.connected', { name: a.name ?? a.server_url })); void load() }
  const row = (k: ReactNode, d: ReactNode, v: ReactNode, key?: string) => (
    <div key={key} className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}><span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm">{k}</span>{d && <span className="truncate text-xs text-[#8FA3C8]">{d}</span>}</span>{v}</div>
  )
  if (error && !accounts) return <>
    {row(t('settings.acct.title'), error, <button type="button" onClick={() => void load()} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('settings.acct.retry')}</button>)}
  </>
  if (!accounts) return row(t('settings.acct.title'), null, <span className="text-[13px] text-[#8FA3C8]">{t('common.loading')}</span>)
  const status = (a: CloudAccount) => a.state === 'refresh_failed' ? <span className="rounded-full bg-[rgba(255,184,77,0.16)] px-2 py-0.5 text-[11px] font-medium text-[#FFB84D]">{t('settings.acct.needsSignIn')}</span>
    : a.state === 'locked' ? <span className={chip}>{t('settings.acct.locked')}</span>
      : <span className="rounded-full bg-[rgba(95,211,154,0.16)] px-2 py-0.5 text-[11px] font-medium text-[#5FD39A]">{t('settings.acct.connectedChip')}</span>
  const showForm = accounts.length === 0 || adding || !!again
  return <>
    {(error || notice) && <p role="status" className={`m-0 px-[18px] py-3 text-[13px] ${rowLine}`} style={{ color: error ? C.red : C.green }}>{error ?? notice}</p>}
    {accounts.length === 0 && row(t('settings.acct.notSignedIn'), t('settings.acct.signInHint'), <span className="text-[13px] text-[#8FA3C8]">{t('settings.acct.signedOut')}</span>)}
    {accounts.map((a) => row(<span className="flex items-center gap-2">{a.name ?? t('settings.acct.title')}{status(a)}</span>,
      `${a.server_url}${a.state === 'refresh_failed' ? ` · ${t('settings.acct.signInAgain')}` : ''}`,
      <span className="flex shrink-0 gap-2">
        {a.state === 'refresh_failed' && again?.id !== a.id && <button type="button" onClick={() => { setNotice(null); setAgain(a) }} className={`${btnPrimary} px-3.5 py-2 text-[13px]`}>{t('settings.acct.signInAgainBtn')}</button>}
        <button type="button" onClick={() => void signOut(a)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('power.signOut')}</button>
      </span>, a.id))}
    {showForm
      ? <div className={rowLine}><CloudSignIn key={again?.id ?? 'new'} accounts={accounts} again={again} autoStart={autoStart && accounts.length === 0} onSignedIn={signedIn} /></div>
      : <div className={`px-[18px] py-3 ${rowLine}`}><button type="button" className={linkBtn} onClick={() => { setNotice(null); setAdding(true) }}>{t('settings.acct.addAnother')}</button></div>}
    {prompt && <UnsentDialog {...prompt} onCancel={() => setPrompt(null)} onChoose={(c) => finish(prompt.account, c)} />}
  </>
}

/** Wait to sync, export, or discard (confirmed) — the three choices SRS WSOS-SYN-008 requires. */
function UnsentDialog({ account, unsent, onCancel, onChoose }: { account: CloudAccount; unsent: number; onCancel: () => void; onChoose: (c: SignOutChoice) => Promise<void> }) {
  const [left, setLeft] = useState(unsent)
  const [waiting, setWaiting] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const n = (k: number) => k === 1 ? t('settings.unsent.one') : t('settings.unsent.many', { count: formatNumber(k) })
  // "Wait to sync": ask for a sync and check every 2 s; sign out once nothing is left.
  useEffect(() => {
    if (!waiting) return
    let stop = false
    const tick = async () => {
      if (stop) return
      await os.syncNow()
      const r = await os.syncUnsent(account.id)
      if (stop) return
      if (r.ok && r.value === 0) { stop = true; await onChoose('none'); return }
      if (r.ok) setLeft(r.value)
      timer = setTimeout(tick, 2000)
    }
    let timer = setTimeout(tick, 0)
    return () => { stop = true; clearTimeout(timer) }
  }, [waiting, account.id, onChoose])
  const run = async (c: SignOutChoice) => { setBusy(true); await onChoose(c); setBusy(false) }
  return (
    <Dialog width={460} alert onClose={busy ? undefined : onCancel}>
      {(tid) => <>
        <div className="flex flex-col gap-3 px-6 pt-6 pb-4">
          <h2 id={tid} className="m-0 text-[19px] font-bold">{n(left)}</h2>
          <p className="m-0 text-sm text-[#C9D6EE]">{t('settings.unsent.body', { server: account.server_url })}</p>
          {waiting ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[rgba(31,107,255,0.12)] px-4 py-3 text-sm" aria-live="polite">
              <span>{t('settings.unsent.syncing')}</span>
              <button type="button" onClick={() => setWaiting(false)} className={linkBtn}>{t('settings.unsent.stop')}</button>
            </div>
          ) : confirmDiscard ? (
            <div className="flex flex-col gap-3 rounded-xl border border-[rgba(255,138,122,0.3)] bg-[rgba(255,138,122,0.08)] px-4 py-3 text-sm">
              <span>{t('settings.unsent.discardQ', { what: n(left) })}</span>
              <div className="flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)} className={btnGhost}>{t('settings.unsent.keep')}</button>
                <button type="button" disabled={busy} onClick={() => void run('discard')} className={`${btnPrimary} bg-[#D9452B] hover:bg-[#E5573D]`}>{t('settings.unsent.discardOut')}</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button type="button" disabled={busy} onClick={() => setWaiting(true)} className={btnPrimary}>{t('settings.unsent.wait')}</button>
              <button type="button" disabled={busy} onClick={() => void run('export')} className={btnGhost}>{t('settings.unsent.export')}</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)} className={`${btnGhost} text-[#FF8A7A]`}>{t('settings.unsent.discard')}</button>
            </div>
          )}
        </div>
        <div className={dialogFooter}><button type="button" disabled={busy} onClick={onCancel} className={btnGhost}>{t('settings.unsent.cancel')}</button></div>
      </>}
    </Dialog>
  )
}
