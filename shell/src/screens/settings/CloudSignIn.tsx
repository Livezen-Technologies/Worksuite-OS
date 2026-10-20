// Settings › Users › WorkSuite account: the real sign-in (#46). OneAuth OIDC authorization code + PKCE runs in the
// system browser through the credentials broker (services/credentials, WSOS-IDN-001); the refresh token goes to the
// Secret Service keyring there and no token or password ever reaches the renderer. This form only picks the server,
// waits for the browser, and offers Cancel / Try again.
import { useEffect, useRef, useState } from 'react'
import { cloudErrorText, defaultSignInTarget, os, serverUrlFor, type CloudAccount } from '../../lib/os'
import { Spinner, btnGhost, btnPrimary, field } from '../../components/Dk'
import { t } from '../../i18n'

type Mode = 'personal' | 'enterprise'

/** Checks the address before the broker sees it: enterprise needs one, and only https is allowed. */
export function signInUrl(mode: Mode, server: string): { url: string } | { error: string } {
  if (mode === 'enterprise' && !server.trim()) return { error: t('setup.enterServer') }
  const url = serverUrlFor(mode, server)
  try { if (new URL(url).protocol !== 'https:') return { error: cloudErrorText('insecure_url') } } catch { return { error: cloudErrorText('discovery_failed') } }
  return { url }
}

export function CloudSignIn({ accounts, autoStart, again, onSignedIn }: {
  accounts: CloudAccount[]
  /** Start at once with the default server (the desktop's "Sign in" button), unless an address must be typed first. */
  autoStart?: boolean
  /** Sign in again to this account's server (its refresh token was refused). */
  again?: CloudAccount | null
  onSignedIn: (a: CloudAccount) => void
}) {
  const [mode, setMode] = useState<Mode>('personal')
  const [server, setServer] = useState('')
  const [managed, setManaged] = useState(false)
  const [ready, setReady] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)
  const started = useRef(false)

  const start = async (m = mode, s = server) => {
    const target = signInUrl(m, s)
    if ('error' in target) { setError(target.error); return }
    cancelled.current = false
    setError(null); setWaiting(true)
    const r = await os.cloudSignIn(target.url, m)
    setWaiting(false)
    if (r.ok) { onSignedIn(r.value); return }
    // The person pressed Cancel: say nothing more than that.
    if (!(cancelled.current && r.error === 'sign_in_cancelled')) setError(cloudErrorText(r.error))
  }
  const cancel = () => { cancelled.current = true; void os.cloudSignInCancel() }

  useEffect(() => {
    let live = true
    void os.deviceInfo().catch(() => null).then((info) => {
      if (!live) return
      const d = again ? defaultSignInTarget({ server: again.server_url, provisioning: undefined }, []) : defaultSignInTarget(info, accounts)
      setMode(d.mode); setServer(d.server); setManaged(!!info?.managed && !!info.server); setReady(true)
      if (autoStart && !started.current && (d.mode === 'personal' || d.server)) { started.current = true; void start(d.mode, d.server) }
    })
    return () => { live = false }
  }, [again?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving Settings while the browser is open ends that sign-in rather than leaving it waiting for 5 minutes.
  const waitingNow = useRef(false)
  useEffect(() => { waitingNow.current = waiting }, [waiting])
  useEffect(() => () => { if (waitingNow.current) void os.cloudSignInCancel() }, [])

  if (!ready) return null
  if (waiting) return (
    <div role="status" className="flex flex-col gap-2 px-[18px] py-3.5">
      <span className="flex items-center gap-2 text-sm"><Spinner />{t('settings.acct.waiting')}</span>
      <span className="text-xs text-[#8FA3C8]">{t('settings.acct.waitingHint', { server: new URL(serverUrlFor(mode, server)).host })}</span>
      <button type="button" onClick={cancel} className={`${btnGhost} self-start px-3.5 py-2 text-[13px]`}>{t('common.cancel')}</button>
    </div>
  )
  return (
    <form className="flex flex-col gap-3 px-[18px] py-3.5" aria-label={t('settings.acct.signIn')} onSubmit={(e) => { e.preventDefault(); void start() }}>
      {!again && !managed && (
        <div role="radiogroup" aria-label={t('settings.acct.kind')} className="flex gap-2">
          {(['personal', 'enterprise'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { setMode(m); setError(null) }}
              className={`flex flex-1 cursor-pointer flex-col gap-0.5 rounded-[10px] border px-3 py-2 text-left ${mode === m ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.14)]' : 'border-[rgba(127,178,255,0.18)]'}`}>
              <span className="text-[13px] font-medium">{t(m === 'personal' ? 'setup.personal' : 'setup.enterprise')}</span>
              <span className="text-[11px] text-[#8FA3C8]">{t(m === 'personal' ? 'setup.personalHint' : 'setup.enterpriseHint')}</span>
            </button>
          ))}
        </div>
      )}
      {mode === 'enterprise' && (
        <label className="flex flex-col gap-1 text-[13px] font-semibold">{t('settings.enroll.server')}
          <input value={server} readOnly={managed || !!again} onChange={(e) => { setServer(e.target.value); setError(null) }} placeholder="work.example.com" spellCheck={false} autoComplete="url" className={`${field} font-normal`} />
        </label>
      )}
      <span className="text-xs text-[#8FA3C8]">{t('settings.acct.browserHint')}</span>
      {error && <p role="alert" className="m-0 text-[13px] text-[#FF8A7A]">{error}</p>}
      <button type="submit" className={`${btnPrimary} self-start px-4 py-2 text-[13px]`}>{error ? t('settings.acct.retry') : again ? t('settings.acct.signInAgainBtn') : t('settings.acct.signIn')}</button>
    </form>
  )
}
