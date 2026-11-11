// The setup wizard on the setup state machine (services/setup, lk.worksuite.Setup1). Each screen is the machine's
// current state: answers go to the service with SetAnswer, Continue/Back are NEXT/BACK events, and the service
// validates and decides the next state (states.ts has the rules). Unattended work, waiting, retries and recovery
// are shown as the service reports them; this component never moves the machine or changes the system itself.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LOCALES, getLocale, localeTag, setLocale, t, type Locale, type MessageKey } from '../../i18n'
import { Button } from '../ui/button'
import { BG, Icon, Mark } from '../Ws'
import FirstRunNetwork from '../../screens/FirstRunNetwork'
import { cloudErrorText, os, serverUrlFor } from '../../lib/os'
import type { SetupApi } from '../../lib/setupApi'
import { flowFor, isMain, type MainState, type SetupEvent } from './core/states.ts'
import { asks, useSetup } from './useSetup'
import RecoveryScreen from './recovery/RecoveryScreen'

export const WORKSUITE_APPS = ['worksuite-desktop', 'worksuite-office', 'worksuite-pos', 'worksuite-desk', 'worksuite-frameflow'] as const
export const THIRD_PARTY_APPS = ['firefox-esr', 'vlc', 'gimp', 'thunderbird'] as const
const TIMEZONES = ['Asia/Colombo', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC']
/** Keyboard layouts (XKB names) with their names as people know them. */
const KEYBOARDS: [string, string][] = [['us', 'English (US)'], ['gb', 'English (UK)'], ['lk', 'සිංහල (Wijesekara)'], ['in+tam', 'தமிழ் (Tamil 99)']]
type HeadingRef = React.RefObject<HTMLHeadingElement | null>
const RECOVERY = new Set(['FAILED', 'RECOVERY_MODE', 'ROLLING_BACK', 'ROLLED_BACK'])

const field = 'h-11 w-full rounded-[10px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3.5 text-[15px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8] focus:border-[#1F6BFF] disabled:opacity-60'
const fieldLabel = 'flex flex-col gap-1.5 text-[13px] font-semibold text-[#C9D6EE]'
const stepName = (s: MainState) => t(`sw.step.${s}` as MessageKey)

export default function SetupWizard({ api, onDone, onExitToRecovery, userName }: { api: SetupApi; onDone: () => void; onExitToRecovery?: () => void; userName?: string }) {
  const s = useSetup(api)
  const heading = useRef<HTMLHeadingElement>(null)
  const state = s.view?.state
  useEffect(() => { heading.current?.focus() }, [state])

  if (!s.view) return (
    <Frame><div role="status" className="m-auto flex flex-col items-center gap-3 text-[#C9D6EE]">
      {s.loadError ? <p role="alert" className="m-0 max-w-[480px] text-center">{s.loadError === 'service_unavailable' ? t('sw.err.unavailable') : t('sw.err.send', { error: s.loadError })}</p>
        : <><Spinner />{t('sw.loading')}</>}
    </div></Frame>
  )

  const v = s.view
  const flow: MainState[] = flowFor(v.mode).filter((x) => x !== 'INITIALIZING')
  // The step the rail highlights: the current main state, or the interrupted one while waiting/retrying/in recovery.
  const at: MainState | null = isMain(v.state) ? v.state : v.resumeTo
  const idx = at ? flow.indexOf(at) : -1
  const err = s.error === 'not_authorized' ? t('sw.err.auth') : s.error === 'service_unavailable' ? t('sw.err.unavailable') : s.error ? t('sw.err.send', { error: s.error }) : null
  const send = (e: SetupEvent) => s.send(e)

  let body: ReactNode
  if (RECOVERY.has(v.state)) body = <RecoveryScreen api={api} view={v} send={send} busy={s.busy} onExit={onExitToRecovery} />
  else if (!isMain(v.state)) body = <SidePanel state={v.state} attempts={v.attempts} lastError={v.lastError} busy={s.busy} send={send} headingRef={heading} />
  else if (v.state === 'SETUP_COMPLETED') body = (
    <Center>
      <span className="flex size-16 items-center justify-center rounded-full bg-[rgba(46,158,106,0.2)] text-[#6FE0A8]"><Icon d={['M5 12l5 5 9-10']} size={32} /></span>
      <h1 ref={heading} tabIndex={-1} className="m-0 text-[34px] font-bold tracking-[-0.03em] outline-none">{t('sw.done.title')}</h1>
      <p className="m-0 text-[17px] text-[#8FA3C8]">{t('sw.done.body')}</p>
      <Button variant="primary" size="xl" className="mt-4" onClick={onDone}>{t('sw.finish')}</Button>
    </Center>
  )
  else if (!asks(v.state)) body = <WorkPanel state={v.state} send={send} busy={s.busy} headingRef={heading} />
  else body = (
    <Ask state={v.state} answers={v.answers} answer={s.answer} fieldErrors={s.fieldErrors} headingRef={heading} send={send} busy={s.busy} userName={userName} first={idx <= 0} />
  )

  return (
    <Frame>
      <nav aria-label={t('sw.steps')} className="hidden w-[260px] shrink-0 flex-col gap-1 border-r border-[rgba(127,178,255,0.12)] py-10 pr-6 pl-8 lg:flex">
        <div className="mb-6 flex items-center gap-3"><Mark size={36} /><span className="text-[15px] font-semibold">WorkSuite OS</span></div>
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
          {flow.map((st, i) => {
            const done = idx > i || v.state === 'SETUP_COMPLETED'
            const cur = i === idx && v.state !== 'SETUP_COMPLETED'
            return (
              <li key={st} aria-current={cur ? 'step' : undefined} className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] ${cur ? 'bg-[rgba(31,107,255,0.18)] font-semibold text-white' : done ? 'text-[#AFC0DD]' : 'text-[#8FA3C8]'}`}>
                <span aria-hidden className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] ${done ? 'bg-[#2E9E6A] text-white' : cur ? 'bg-[#1F6BFF] text-white' : 'border border-[rgba(127,178,255,0.3)]'}`}>
                  {done ? <Icon d={['M5 12l5 5 9-10']} size={12} width={3} /> : i + 1}
                </span>
                {stepName(st)}
              </li>
            )
          })}
        </ol>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-auto px-6 py-10 md:px-12">
        {idx >= 0 && v.state !== 'SETUP_COMPLETED' && <p className="m-0 text-[13px] font-medium tracking-wide text-[#8FA3C8] uppercase">{t('sw.progress', { n: idx + 1, total: flow.length })}</p>}
        {err && <p role="alert" className="m-0 rounded-xl border border-[rgba(217,69,43,0.4)] bg-[rgba(217,69,43,0.12)] px-4 py-3 text-sm text-[#FFB4A6]">{err}</p>}
        {body}
      </div>
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="ws-setup-bg flex h-full w-full overflow-hidden font-sans text-[#E8EEFA]" style={{ '--ws-setup-bg': BG.setupCenter } as React.CSSProperties}>{children}</main>
  )
}
const Center = ({ children }: { children: ReactNode }) => <section className="m-auto flex max-w-[620px] flex-col items-center gap-3 text-center">{children}</section>
const Spinner = () => <span aria-hidden className="size-9 animate-spin rounded-full border-[3px] border-[rgba(127,178,255,0.25)] border-t-[#7FB2FF] motion-reduce:animate-none" />

type AskProps = {
  state: MainState; answers: Record<string, unknown>; answer: (k: string, v: unknown) => Promise<boolean>; fieldErrors: Record<string, string>
  headingRef: HeadingRef; send: (e: SetupEvent) => Promise<boolean>; busy: boolean; userName?: string; first: boolean
}

function Ask({ state, answers, answer, fieldErrors, headingRef, send, busy, userName, first }: AskProps) {
  const [extraError, setExtraError] = useState<string | null>(null)
  const [enroll, setEnroll] = useState({ server: '', code: '' })
  const a = answers as Record<string, any>

  // Defaults a person can accept with Continue (still sent as answers, so the service validates them).
  useEffect(() => {
    if (state === 'LANGUAGE_REGION') {
      if (!a.locale) void answer('locale', getLocale())
      if (!a.timezone) void answer('timezone', Intl.DateTimeFormat(localeTag()).resolvedOptions().timeZone || 'UTC')
      if (!a.keyboard) void answer('keyboard', 'us')
    }
    if (state === 'SECURITY_CONFIGURATION' && !a.encryption) void answer('encryption', { enabled: true })
    if (state === 'WORKSUITE_APP_SELECTION' && !Array.isArray(a.worksuiteApps)) void answer('worksuiteApps', ['worksuite-desktop', 'worksuite-office'])
    if (state === 'ACCOUNT_AUTHENTICATION' && !a.account && userName) void answer('account', { user: userName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'user', name: userName })
  }, [state])

  const next = async () => {
    setExtraError(null)
    if (state === 'DEVICE_ENROLLMENT' && enroll.code.trim()) {
      if (!enroll.server.trim()) return setExtraError(t('setup.enterServer'))
      const r = await os.enrollDevice(serverUrlFor('enterprise', enroll.server), enroll.code)
      if (!r.ok) return setExtraError(cloudErrorText(r.error))
    }
    await send({ type: 'NEXT' })
  }
  const errOf = (k: string) => fieldErrors[k] ? <span role="alert" className="text-[12.5px] font-normal text-[#FFB4A6]">{t('sw.err.field')}</span> : null
  const toggle = (key: string, id: string, list: string[]) => void answer(key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  let content: ReactNode = null
  switch (state) {
    case 'WELCOME':
      content = <p className="m-0 max-w-[620px] text-[17px] leading-relaxed text-[#C9D6EE]">{t('sw.welcome.body')}</p>
      break
    case 'LANGUAGE_REGION':
      content = (
        <div className="grid max-w-[620px] grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={fieldLabel}>{t('sw.lang.language')}
            <select className={field} value={a.locale ?? getLocale()} onChange={(e) => { setLocale(e.target.value as Locale); void answer('locale', e.target.value) }}>
              {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>{errOf('locale')}
          </label>
          <label className={fieldLabel}>{t('sw.lang.timezone')}
            <select className={field} value={a.timezone ?? ''} onChange={(e) => void answer('timezone', e.target.value)}>
              {[...new Set([...(a.timezone ? [a.timezone as string] : []), ...TIMEZONES])].map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </select>{errOf('timezone')}
          </label>
          <label className={fieldLabel}>{t('sw.lang.keyboard')}
            <select className={field} value={a.keyboard ?? 'us'} onChange={(e) => void answer('keyboard', e.target.value)}>
              {KEYBOARDS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>{errOf('keyboard')}
          </label>
        </div>
      )
      break
    case 'NETWORK_SETUP':
      content = <div className="flex max-w-[620px] flex-col gap-4"><p className="m-0 text-[15px] leading-relaxed text-[#C9D6EE]">{t('sw.net.body')}</p><FirstRunNetwork /></div>
      break
    case 'ACCOUNT_TYPE':
      content = (
        <div role="radiogroup" aria-label={stepName(state)} className="grid max-w-[720px] grid-cols-1 gap-3 sm:grid-cols-2">
          {(['personal', 'enterprise'] as const).map((k) => (
            <Choice key={k} role="radio" checked={a.accountType === k} onClick={() => void answer('accountType', k)}
              icon={k === 'personal' ? 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' : 'M3 21V7l9-4 9 4v14M9 21v-6h6v6'}
              title={t(`sw.type.${k}`)} hint={t(`sw.type.${k}Hint`)} />
          ))}
          {errOf('accountType')}
        </div>
      )
      break
    case 'ACCOUNT_AUTHENTICATION':
      content = (
        <div className="grid max-w-[620px] grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={fieldLabel}>{t('sw.account.name')}
            <input className={field} value={a.account?.name ?? ''} autoComplete="name" onChange={(e) => void answer('account', { ...(a.account ?? {}), user: a.account?.user ?? '', name: e.target.value })} />
          </label>
          <label className={fieldLabel}>{t('sw.account.user')}
            <input className={field} value={a.account?.user ?? ''} autoComplete="username" spellCheck={false}
              onChange={(e) => void answer('account', { ...(a.account ?? {}), user: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) })} />
            {errOf('account')}
          </label>
          <p className="m-0 text-[13px] text-[#8FA3C8] sm:col-span-2">{t('sw.account.userHint')}</p>
        </div>
      )
      break
    case 'DEVICE_ENROLLMENT':
      content = (
        <div className="flex max-w-[620px] flex-col gap-4">
          <p className="m-0 text-[15px] leading-relaxed text-[#C9D6EE]">{t('sw.enroll.body')}</p>
          <label className={fieldLabel}>{t('settings.enroll.server')}<input className={field} value={enroll.server} placeholder="work.example.com" onChange={(e) => setEnroll((x) => ({ ...x, server: e.target.value }))} /></label>
          <label className={fieldLabel}>{t('setup.codeOptional')}<input className={field} value={enroll.code} spellCheck={false} onChange={(e) => setEnroll((x) => ({ ...x, code: e.target.value }))} /></label>
        </div>
      )
      break
    case 'STORAGE_CONFIGURATION':
      content = (
        <div className="flex max-w-[620px] flex-col gap-4">
          <p className="m-0 rounded-xl border border-[rgba(240,166,60,0.35)] bg-[rgba(240,166,60,0.1)] px-4 py-3 text-[14px] leading-relaxed text-[#FFD9A0]">{t('sw.storage.body')}</p>
          <label className={fieldLabel}>{t('sw.storage.disk')}<input className={field} value={a.disk ?? ''} spellCheck={false} onChange={(e) => void answer('disk', e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32))} />{errOf('disk')}</label>
          {a.disk && <label className={fieldLabel}>{t('sw.storage.confirm', { disk: a.disk })}<input className={field} value={a.diskConfirmed ?? ''} spellCheck={false} onChange={(e) => void answer('diskConfirmed', e.target.value.slice(0, 32))} />{errOf('diskConfirmed')}</label>}
        </div>
      )
      break
    case 'SECURITY_CONFIGURATION':
      content = (
        <div className="max-w-[620px]">
          <Choice role="checkbox" checked={!!a.encryption?.enabled} onClick={() => void answer('encryption', { enabled: !a.encryption?.enabled })}
            icon="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z" title={t('sw.sec.encrypt')} hint={t('sw.sec.encryptHint')} />
          {errOf('encryption')}
        </div>
      )
      break
    case 'WORKSUITE_APP_SELECTION': {
      const list: string[] = Array.isArray(a.worksuiteApps) ? a.worksuiteApps : []
      content = (
        <div className="flex max-w-[720px] flex-col gap-3">
          <p className="m-0 text-[15px] text-[#C9D6EE]">{t('sw.apps.body')}</p>
          {WORKSUITE_APPS.map((id) => {
            const required = id === 'worksuite-desktop'
            return <Choice key={id} role="checkbox" checked={required || list.includes(id)} disabled={required} onClick={() => toggle('worksuiteApps', id, list)}
              title={t(`sw.app.${id}` as MessageKey)} badge={required ? t('sw.apps.required') : undefined} />
          })}
          {errOf('worksuiteApps')}
        </div>
      )
      break
    }
    case 'THIRD_PARTY_APP_SELECTION': {
      const list: string[] = Array.isArray(a.thirdPartyApps) ? a.thirdPartyApps : []
      content = (
        <div className="flex max-w-[720px] flex-col gap-3">
          <p className="m-0 text-[15px] text-[#C9D6EE]">{t('sw.third.body')}</p>
          {THIRD_PARTY_APPS.map((id) => <Choice key={id} role="checkbox" checked={list.includes(id)} onClick={() => toggle('thirdPartyApps', id, list)} title={t(`sw.third.${id}` as MessageKey)} />)}
        </div>
      )
      break
    }
    case 'AI_MCP_CONFIGURATION':
      content = (
        <div className="max-w-[620px]">
          <Choice role="checkbox" checked={!!a.aiMcp?.enabled} onClick={() => void answer('aiMcp', { enabled: !a.aiMcp?.enabled })}
            icon="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" title={t('sw.ai.enable')} hint={t('sw.ai.enableHint')} />
        </div>
      )
      break
    case 'REVIEW_CONFIGURATION':
      content = <Review answers={a} send={send} answer={answer} errOf={errOf} />
      break
  }

  return (
    <section className="flex flex-col gap-6">
      {state === 'WELCOME' && <Mark size={72} />}
      <h1 ref={headingRef} tabIndex={-1} className="m-0 text-[34px] leading-tight font-bold tracking-[-0.02em] outline-none">{state === 'WELCOME' ? t('sw.welcome.title') : stepName(state)}</h1>
      {content}
      {extraError && <p role="alert" className="m-0 text-sm text-[#FFB4A6]">{extraError}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        {!first && <Button variant="secondary" size="lg" disabled={busy} onClick={() => void send({ type: 'BACK' })}>{t('sw.back')}</Button>}
        <Button variant="primary" size="lg" disabled={busy} onClick={() => void next()}>{busy ? t('sw.busy') : state === 'WELCOME' ? t('sw.start') : t('sw.next')}</Button>
      </div>
    </section>
  )
}

function Review({ answers: a, send, answer, errOf }: { answers: Record<string, any>; send: (e: SetupEvent) => Promise<boolean>; answer: (k: string, v: unknown) => Promise<boolean>; errOf: (k: string) => ReactNode }) {
  const yesNo = (b: unknown) => t(b ? 'sw.review.yes' : 'sw.review.no')
  const names = (ids: unknown, prefix: string) => Array.isArray(ids) && ids.length ? ids.map((id) => t(`${prefix}${id}` as MessageKey).split(':')[0]).join(', ') : t('sw.review.none')
  const rows: [MainState, string, string][] = useMemo(() => [
    ['LANGUAGE_REGION', t('sw.lang.language'), LOCALES.find((l) => l.id === a.locale)?.name ?? String(a.locale ?? '—')],
    ['LANGUAGE_REGION', t('sw.lang.timezone'), String(a.timezone ?? '—').replace(/_/g, ' ')],
    ['LANGUAGE_REGION', t('sw.lang.keyboard'), KEYBOARDS.find(([id]) => id === a.keyboard)?.[1] ?? String(a.keyboard ?? '—')],
    ['ACCOUNT_TYPE', t('sw.step.ACCOUNT_TYPE'), a.accountType ? t(`sw.type.${a.accountType as 'personal' | 'enterprise'}`) : '—'],
    ['ACCOUNT_AUTHENTICATION', t('sw.account.user'), String(a.account?.user ?? '—')],
    ['SECURITY_CONFIGURATION', t('sw.sec.encrypt'), yesNo(a.encryption?.enabled)],
    ['WORKSUITE_APP_SELECTION', t('sw.step.WORKSUITE_APP_SELECTION'), names(a.worksuiteApps, 'sw.app.')],
    ['THIRD_PARTY_APP_SELECTION', t('sw.step.THIRD_PARTY_APP_SELECTION'), names(a.thirdPartyApps, 'sw.third.')],
    ['AI_MCP_CONFIGURATION', t('sw.ai.enable'), yesNo(a.aiMcp?.enabled)],
  ], [a])
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <p className="m-0 text-[15px] text-[#C9D6EE]">{t('sw.review.body')}</p>
      <dl className="m-0 divide-y divide-[rgba(127,178,255,0.12)] rounded-2xl border border-[rgba(127,178,255,0.18)] bg-[rgba(10,24,56,0.55)]">
        {rows.map(([st, label, value]) => (
          <div key={label} className="flex items-center gap-4 px-4 py-3">
            <dt className="w-44 shrink-0 text-[13px] text-[#8FA3C8]">{label}</dt>
            <dd className="m-0 min-w-0 flex-1 text-[15px] break-words">{value}</dd>
            <Button variant="link" size="xs" onClick={() => void send({ type: 'GOTO', to: st })}>{t('sw.review.edit')}</Button>
          </div>
        ))}
      </dl>
      <label className="flex cursor-pointer items-center gap-3 text-[15px]">
        <input type="checkbox" className="size-5 accent-[#1F6BFF]" checked={a.reviewAccepted === true} onChange={(e) => void answer('reviewAccepted', e.target.checked)} />
        {t('sw.review.accept')}
      </label>
      {errOf('reviewAccepted')}
    </div>
  )
}

function Choice({ role, checked, onClick, title, hint, icon, badge, disabled }: { role: 'radio' | 'checkbox'; checked: boolean; onClick: () => void; title: string; hint?: string; icon?: string; badge?: string; disabled?: boolean }) {
  return (
    <button type="button" role={role} aria-checked={checked} disabled={disabled} onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-3 rounded-2xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7FB2FF] disabled:cursor-default ${checked ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.14)]' : 'border-[rgba(127,178,255,0.18)] bg-[rgba(10,24,56,0.55)] hover:border-[rgba(127,178,255,0.4)]'}`}>
      {icon && <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[rgba(31,107,255,0.18)] text-[#9CC2FF]"><Icon d={[icon]} size={20} /></span>}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-[#E8EEFA]">{title}{badge && <span className="rounded-full bg-[rgba(127,178,255,0.18)] px-2 py-0.5 text-[11px] font-semibold text-[#C9D6EE]">{badge}</span>}</span>
        {hint && <span className="text-[13.5px] leading-snug text-[#AFC0DD]">{hint}</span>}
      </span>
      <span aria-hidden className={`mt-1 flex size-5 shrink-0 items-center justify-center ${role === 'radio' ? 'rounded-full' : 'rounded-md'} border ${checked ? 'border-[#1F6BFF] bg-[#1F6BFF] text-white' : 'border-[rgba(127,178,255,0.4)]'}`}>
        {checked && <Icon d={['M5 12l5 5 9-10']} size={12} width={3} />}
      </span>
    </button>
  )
}

function WorkPanel({ state, send, busy, headingRef }: { state: MainState; send: (e: SetupEvent) => Promise<boolean>; busy: boolean; headingRef: HeadingRef }) {
  return (
    <Center>
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-4">
        <Spinner />
        <h1 ref={headingRef} tabIndex={-1} className="m-0 text-[30px] font-bold tracking-[-0.02em] outline-none">{stepName(state)}</h1>
      </div>
      <p className="m-0 text-[15px] text-[#8FA3C8]">{t('sw.work.body')}</p>
      <Button variant="secondary" size="md" className="mt-2" disabled={busy} onClick={() => void send({ type: 'PAUSE' })}>{t('sw.pause')}</Button>
    </Center>
  )
}

function SidePanel({ state, attempts, lastError, busy, send, headingRef }: { state: string; attempts: number; lastError: string | null; busy: boolean; send: (e: SetupEvent) => Promise<boolean>; headingRef: HeadingRef }) {
  const hintKey = `sw.side.${state}Hint` as MessageKey
  const hint = state === 'RETRYING' ? t('sw.side.RETRYINGHint', { n: attempts, error: lastError ?? '—' }) : (['PAUSED', 'WAITING_FOR_NETWORK', 'WAITING_FOR_ADMIN_APPROVAL', 'CANCELLED'].includes(state) ? t(hintKey) : null)
  const actions: [MessageKey, SetupEvent, 'primary' | 'secondary'][] = ({
    PAUSED: [['sw.resume', { type: 'RESUME' }, 'primary'], ['sw.cancel', { type: 'CANCEL' }, 'secondary']],
    WAITING_FOR_NETWORK: [['sw.pause', { type: 'PAUSE' }, 'secondary']],
    WAITING_FOR_USER: [['sw.next', { type: 'USER_DONE' }, 'primary'], ['sw.cancel', { type: 'CANCEL' }, 'secondary']],
    WAITING_FOR_ADMIN_APPROVAL: [['sw.cancel', { type: 'CANCEL' }, 'secondary']],
    RETRYING: [['sw.side.retryNow', { type: 'RETRY_NOW' }, 'primary'], ['sw.pause', { type: 'PAUSE' }, 'secondary']],
    CANCELLED: [['sw.restart', { type: 'RESTART_SETUP' }, 'primary']],
  } as Record<string, [MessageKey, SetupEvent, 'primary' | 'secondary'][]>)[state] ?? []
  return (
    <Center>
      {['WAITING_FOR_NETWORK', 'WAITING_FOR_ADMIN_APPROVAL', 'RETRYING'].includes(state) && <Spinner />}
      <h1 ref={headingRef} tabIndex={-1} className="m-0 text-[30px] font-bold tracking-[-0.02em] outline-none">{t(`sw.side.${state}` as MessageKey)}</h1>
      {hint && <p className="m-0 text-[15px] break-words text-[#8FA3C8]">{hint}</p>}
      {state === 'WAITING_FOR_NETWORK' && <div className="w-full text-left"><FirstRunNetwork /></div>}
      <div className="mt-3 flex flex-wrap justify-center gap-3">
        {actions.map(([label, e, variant]) => <Button key={label} variant={variant} size="lg" disabled={busy} onClick={() => void send(e)}>{t(label)}</Button>)}
      </div>
    </Center>
  )
}
