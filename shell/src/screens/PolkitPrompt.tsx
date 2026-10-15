// Administrator password prompt drawn by the shell (WSOS-INT-010), shown by the polkit agent process
// (electron/polkitMode.ts) in its own always-on-top window. Names the requesting program, the action and the
// administrator account. The password field is cleared after every attempt and never stored.
import { useEffect, useState, type FormEvent } from 'react'
import { btnGhost, btnPrimary, dialogFooter, field } from '../components/Dk'
import { t } from '../i18n'

export interface PolkitRequest { cookie: string; action: string; message: string; program: string | null; accounts: string[] }
export interface PolkitApi {
  request(): Promise<{ request: PolkitRequest; retry: boolean } | null>
  answer(account: string, password: string): Promise<boolean>
  cancel(): Promise<boolean>
  onChange(cb: (p: unknown) => void): () => void
}
declare global {
  interface Window { worksuitePolkit?: PolkitApi }
}

export default function PolkitPrompt() {
  const api = typeof window !== 'undefined' ? window.worksuitePolkit : undefined
  const [state, setState] = useState<{ request: PolkitRequest; retry: boolean } | null>(null)
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!api) return
    const apply = (p: unknown) => {
      const s = p as { request: PolkitRequest; retry: boolean } | null
      setState(s); setBusy(false); setPassword('')
      setAccount((a) => (s && s.request.accounts.includes(a) ? a : s?.request.accounts[0] ?? ''))
    }
    void api.request().then(apply).catch(() => {})
    return api.onChange(apply)
  }, [api])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void api?.cancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api])

  if (!state) return <main className="h-screen bg-[#0F2350]" />
  const { request: r, retry } = state
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!password || !account) return
    setBusy(true)
    const p = password
    setPassword('')
    void api?.answer(account, p)
  }
  return (
    <main className="flex h-screen flex-col bg-[#0F2350] font-sans text-[#E8EEFA]" role="dialog" aria-modal="true" aria-labelledby="pk-title">
      <form onSubmit={submit} className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-3 px-6 pt-6 pb-4">
          <h1 id="pk-title" className="m-0 text-[19px] font-bold">{t('polkit.title')}</h1>
          <p className="m-0 text-sm text-[#C9D6EE]">{r.message}</p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-[#8FA3C8]">{t('polkit.program')}</dt><dd className="m-0 break-all">{r.program ?? t('common.unknown')}</dd>
            <dt className="text-[#8FA3C8]">{t('polkit.action')}</dt><dd className="m-0 break-all">{r.action}</dd>
          </dl>
          {r.accounts.length > 1 ? (
            <label className="flex flex-col gap-1 text-[13px]">{t('polkit.account')}
              <select value={account} onChange={(e) => setAccount(e.target.value)} className={field}>
                {r.accounts.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          ) : <p className="m-0 text-[13px]">{t('polkit.asAccount', { account })}</p>}
          <label className="flex flex-col gap-1 text-[13px]">{t('polkit.password')}
            <input type="password" autoFocus autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} className={field} />
          </label>
          {retry && !busy && <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{t('polkit.wrong')}</p>}
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={() => void api?.cancel()} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
          <button type="submit" disabled={!password || busy} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{busy ? t('polkit.checking') : t('polkit.authenticate')}</button>
        </div>
      </form>
    </main>
  )
}
