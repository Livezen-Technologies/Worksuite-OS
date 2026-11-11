// The setup wizard on the setup state machine (services/setup, lk.worksuite.Setup1). Each screen is the machine's
// current state: answers go to the service with SetAnswer, Continue/Back are NEXT/BACK events, and the service
// validates and decides the next state (states.ts has the rules). Unattended work, waiting, retries and recovery
// are shown as the service reports them; this component never moves the machine or changes the system itself.
//
// Layout: a rail with the four phases of setup and overall progress (a slim bar on narrow screens), one column of
// content per step with its own subtitle, and a sticky action bar (Enter continues).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LOCALES, getLocale, localeTag, setLocale, t, type Locale, type MessageKey } from '../../i18n'
import { Button } from '../ui/button'
import { BG, Icon, Mark } from '../Ws'
import FirstRunNetwork from '../../screens/FirstRunNetwork'
import { cloudErrorText, os, serverUrlFor } from '../../lib/os'
import type { AppProgress, SetupApi } from '../../lib/setupApi'
import { flowFor, isMain, WORK_STATES, type MainState, type SetupEvent } from './core/states.ts'
import { asks, useSetup } from './useSetup'
import RecoveryScreen from './recovery/RecoveryScreen'
import InstallGraphic from './InstallGraphic'
import worksuitePng from '../../assets/brand/worksuite.png'
import officePng from '../../assets/brand/worksuite-office.png'
import posPng from '../../assets/brand/worksuite-pos.png'
import deskPng from '../../assets/brand/worksuite-desk.png'
import frameflowPng from '../../assets/brand/worksuite-frameflow.png'

export const WORKSUITE_APPS = ['worksuite-desktop', 'worksuite-office', 'worksuite-pos', 'worksuite-desk', 'worksuite-frameflow'] as const
export const THIRD_PARTY_APPS = ['firefox-esr', 'vlc', 'gimp', 'thunderbird'] as const
/** The apps' own package icons (256 px, from their .debs). */
const APP_ICON: Record<(typeof WORKSUITE_APPS)[number], string> = {
  'worksuite-desktop': worksuitePng, 'worksuite-office': officePng, 'worksuite-pos': posPng, 'worksuite-desk': deskPng, 'worksuite-frameflow': frameflowPng,
}
/** Third-party apps: a glyph on the app's brand colour (their icons are not bundled with the shell). */
const THIRD_LOOK: Record<(typeof THIRD_PARTY_APPS)[number], [string, string]> = {
  'firefox-esr': ['M12 3a9 9 0 1 0 9 9M3.6 9h16.8M3.6 15h16.8M12 3c2.5 2.6 3.5 5.6 3.5 9s-1 6.4-3.5 9c-2.5-2.6-3.5-5.6-3.5-9s1-6.4 3.5-9z', '#E66000'],
  vlc: ['M8 5v14l11-7z', '#F08A00'],
  gimp: ['M4 20l4-1 11-11-3-3L5 16zM14 6l3 3', '#5C5543'],
  thunderbird: ['M4 6h16v12H4zM4 7l8 6 8-6', '#0A84FF'],
}
const TIMEZONES = ['Asia/Colombo', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC']
/** Keyboard layouts (XKB names) with their names as people know them. */
const KEYBOARDS: [string, string][] = [['us', 'English (US)'], ['gb', 'English (UK)'], ['lk', 'සිංහල (Wijesekara)'], ['in+tam', 'தமிழ் (Tamil 99)']]
type HeadingRef = React.RefObject<HTMLHeadingElement | null>
const RECOVERY = new Set(['FAILED', 'RECOVERY_MODE', 'ROLLING_BACK', 'ROLLED_BACK'])

/** The four phases the rail shows; every main state belongs to one. */
const PHASES: { key: 'start' | 'account' | 'apps' | 'install'; states: readonly MainState[]; icon: string }[] = [
  { key: 'start', states: ['WELCOME', 'LANGUAGE_REGION', 'NETWORK_SETUP'], icon: 'M12 3l2.4 5.6L20 9.3l-4.3 3.9 1.2 5.8L12 16l-4.9 3 1.2-5.8L4 9.3l5.6-.7z' },
  { key: 'account', states: ['ACCOUNT_TYPE', 'ACCOUNT_AUTHENTICATION', 'DEVICE_ENROLLMENT'], icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' },
  { key: 'apps', states: ['STORAGE_CONFIGURATION', 'SECURITY_CONFIGURATION', 'WORKSUITE_APP_SELECTION', 'THIRD_PARTY_APP_SELECTION', 'AI_MCP_CONFIGURATION'], icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { key: 'install', states: ['REVIEW_CONFIGURATION', 'PRE_INSTALL_VALIDATION', 'INSTALLING_OS', 'INSTALLING_APPLICATIONS', 'VERIFYING_INSTALLATION', 'FINAL_CONFIGURATION', 'SETUP_COMPLETED'], icon: 'M12 4v11M7 10l5 5 5-5M5 20h14' },
]
const phaseOf = (s: MainState) => PHASES.find((p) => p.states.includes(s)) ?? PHASES[0]

const field = 'h-12 w-full rounded-xl border border-[rgba(127,178,255,0.22)] bg-[rgba(4,10,26,0.55)] px-4 text-[15px] text-[#E8EEFA] outline-none transition-colors placeholder:text-[#8FA3C8] hover:border-[rgba(127,178,255,0.4)] focus:border-[#1F6BFF] focus:bg-[rgba(4,10,26,0.75)] disabled:opacity-60'
const fieldLabel = 'flex flex-col gap-2 text-[13px] font-semibold text-[#C9D6EE]'
const stepName = (s: MainState) => t(`sw.step.${s}` as MessageKey)
const SUBTITLED = new Set<MainState>(['LANGUAGE_REGION', 'NETWORK_SETUP', 'ACCOUNT_TYPE', 'ACCOUNT_AUTHENTICATION', 'DEVICE_ENROLLMENT', 'STORAGE_CONFIGURATION', 'SECURITY_CONFIGURATION', 'WORKSUITE_APP_SELECTION', 'THIRD_PARTY_APP_SELECTION', 'AI_MCP_CONFIGURATION', 'REVIEW_CONFIGURATION'])
const CHECK = 'M5 12l5 5 9-10'

export default function SetupWizard({ api, onDone, onExitToRecovery, userName }: { api: SetupApi; onDone: () => void; onExitToRecovery?: () => void; userName?: string }) {
  const s = useSetup(api)
  const heading = useRef<HTMLHeadingElement>(null)
  const state = s.view?.state
  useEffect(() => { heading.current?.focus() }, [state])

  if (!s.view) return (
    <Frame><div role="status" className="m-auto flex flex-col items-center gap-4 text-[#C9D6EE]">
      {s.loadError ? <p role="alert" className="m-0 max-w-[480px] text-center">{s.loadError === 'service_unavailable' ? t('sw.err.unavailable') : t('sw.err.send', { error: s.loadError })}</p>
        : <><Mark size={56} /><Spinner />{t('sw.loading')}</>}
    </div></Frame>
  )

  const v = s.view
  const flow: MainState[] = flowFor(v.mode).filter((x) => x !== 'INITIALIZING')
  // The step the rail highlights: the current main state, or the interrupted one while waiting/retrying/in recovery.
  const at: MainState | null = isMain(v.state) ? v.state : v.resumeTo
  const idx = at ? flow.indexOf(at) : -1
  const complete = v.state === 'SETUP_COMPLETED'
  const pct = complete ? 100 : Math.max(0, Math.round((Math.max(idx, 0) / (flow.length - 1)) * 100))
  const err = s.error === 'not_authorized' ? t('sw.err.auth') : s.error === 'service_unavailable' ? t('sw.err.unavailable') : s.error ? t('sw.err.send', { error: s.error }) : null
  const send = (e: SetupEvent) => s.send(e)

  let body: ReactNode
  if (RECOVERY.has(v.state)) body = <RecoveryScreen api={api} view={v} send={send} busy={s.busy} onExit={onExitToRecovery} />
  else if (!isMain(v.state)) body = <SidePanel state={v.state} attempts={v.attempts} lastError={v.lastError} busy={s.busy} send={send} headingRef={heading} />
  else if (complete) body = <DonePanel answers={v.answers} onDone={onDone} headingRef={heading} />
  else if (!asks(v.state)) body = <WorkPanel api={api} state={v.state} flow={flow} send={send} busy={s.busy} headingRef={heading} />
  else body = <Ask state={v.state} answers={v.answers} answer={s.answer} fieldErrors={s.fieldErrors} headingRef={heading} send={send} busy={s.busy} userName={userName} first={idx <= 0} />

  return (
    <Frame>
      <Rail flow={flow} idx={idx} complete={complete} pct={pct} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Narrow screens: no rail, a slim progress bar instead. */}
        <div className="flex items-center gap-3 border-b border-[rgba(127,178,255,0.1)] px-5 py-3 lg:hidden">
          <Mark size={28} />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(127,178,255,0.14)]" aria-hidden><div className="h-full rounded-full bg-gradient-to-r from-[#1F6BFF] to-[#18D4F0] transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
          <span className="text-[12px] font-medium text-[#AFC0DD]">{t('sw.percent', { n: pct })}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-5 px-6 pt-10 pb-6 md:px-10 lg:pt-14">
            {err && <p role="alert" className="ws-rise m-0 flex items-start gap-2.5 rounded-xl border border-[rgba(217,69,43,0.4)] bg-[rgba(217,69,43,0.12)] px-4 py-3 text-sm text-[#FFB4A6]"><Icon d={['M12 8v5M12 16.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z']} size={18} />{err}</p>}
            <div key={v.state} className="ws-rise flex flex-1 flex-col">{body}</div>
          </div>
        </div>
      </div>
    </Frame>
  )
}

function Rail({ flow, idx, complete, pct }: { flow: MainState[]; idx: number; complete: boolean; pct: number }) {
  const current = idx >= 0 ? flow[idx] : null
  const curPhase = current ? phaseOf(current).key : complete ? 'install' : 'start'
  return (
    <nav aria-label={t('sw.steps')} className="hidden w-[300px] shrink-0 flex-col gap-6 border-r border-[rgba(127,178,255,0.1)] bg-[rgba(3,8,22,0.35)] px-6 py-9 backdrop-blur-md lg:flex">
      <div className="flex items-center gap-3"><Mark size={38} /><span className="text-[17px] font-semibold tracking-[-0.01em]">WorkSuite OS</span></div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-[12px] font-medium text-[#AFC0DD]"><span>{idx >= 0 && !complete ? t('sw.progress', { n: idx + 1, total: flow.length }) : ''}</span><span>{t('sw.percent', { n: pct })}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(127,178,255,0.14)]" aria-hidden><div className="h-full rounded-full bg-gradient-to-r from-[#1F6BFF] to-[#18D4F0] transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
      </div>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {PHASES.map((p) => {
          const steps = p.states.filter((st) => flow.includes(st))
          if (!steps.length) return null
          const last = flow.indexOf(steps[steps.length - 1])
          const done = complete || idx > last
          const cur = !complete && p.key === curPhase
          return (
            <li key={p.key} className={`rounded-2xl transition-colors ${cur ? 'bg-[rgba(31,107,255,0.12)] ring-1 ring-[rgba(127,178,255,0.18)]' : ''}`}>
              <div className={`flex items-center gap-3 px-3 py-2.5 text-[14px] ${cur ? 'font-semibold text-white' : done ? 'text-[#C9D6EE]' : 'text-[#8FA3C8]'}`}>
                <span aria-hidden className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${done ? 'bg-[#2E9E6A] text-white' : cur ? 'bg-[#1F6BFF] text-white shadow-[0_4px_14px_rgba(31,107,255,0.45)]' : 'bg-[rgba(127,178,255,0.1)] text-[#8FA3C8]'}`}>
                  <Icon d={[done ? CHECK : p.icon]} size={14} width={done ? 3 : 2} />
                </span>
                {t(`sw.phase.${p.key}`)}
              </div>
              {cur && (
                <ol className="m-0 flex list-none flex-col gap-0.5 p-0 pb-2.5 pl-[46px]">
                  {steps.map((st) => {
                    const i = flow.indexOf(st)
                    const isCur = i === idx
                    return (
                      <li key={st} aria-current={isCur ? 'step' : undefined} className={`relative flex items-center gap-2 py-1 pr-3 text-[13px] ${isCur ? 'font-semibold text-white' : i < idx ? 'text-[#AFC0DD]' : 'text-[#8FA3C8]'}`}>
                        <span aria-hidden className={`size-1.5 rounded-full ${isCur ? 'bg-[#7FB2FF] ring-4 ring-[rgba(127,178,255,0.2)]' : i < idx ? 'bg-[#2E9E6A]' : 'bg-[rgba(127,178,255,0.3)]'}`} />
                        {stepName(st)}
                      </li>
                    )
                  })}
                </ol>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return <main className="ws-setup-bg flex h-full w-full overflow-hidden font-sans text-[#E8EEFA]" style={{ '--ws-setup-bg': BG.setupCenter } as React.CSSProperties}>{children}</main>
}
const Center = ({ children }: { children: ReactNode }) => <section className="m-auto flex w-full max-w-[620px] flex-col items-center gap-3 py-6 text-center">{children}</section>
const Spinner = ({ size = 36 }: { size?: number }) => <span aria-hidden style={{ width: size, height: size }} className="animate-spin rounded-full border-[3px] border-[rgba(127,178,255,0.2)] border-t-[#7FB2FF] motion-reduce:animate-none" />

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
  const errOf = (k: string) => fieldErrors[k] ? <span role="alert" className="flex items-center gap-1.5 text-[12.5px] font-normal text-[#FFB4A6]"><Icon d={['M12 8v5M12 16.5v.5']} size={14} />{t('sw.err.field')}</span> : null
  const toggle = (key: string, id: string, list: string[]) => void answer(key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  let content: ReactNode = null
  switch (state) {
    case 'WELCOME':
      content = (
        <div className="flex flex-col gap-6">
          <p className="m-0 max-w-[600px] text-[17px] leading-relaxed text-[#C9D6EE]">{t('sw.welcome.body')}</p>
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
            {([['sw.welcome.f1', 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'], ['sw.welcome.f2', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'], ['sw.welcome.f3', 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4']] as [MessageKey, string][]).map(([k, d]) => (
              <li key={k} className="flex items-center gap-3 rounded-2xl border border-[rgba(127,178,255,0.14)] bg-[rgba(10,24,56,0.45)] p-4 text-[14px] font-medium text-[#E8EEFA]">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[rgba(31,107,255,0.18)] text-[#9CC2FF]"><Icon d={[d]} size={18} /></span>{t(k)}
              </li>
            ))}
          </ul>
        </div>
      )
      break
    case 'LANGUAGE_REGION':
      content = (
        <div className="flex flex-col gap-5">
          <div role="radiogroup" aria-label={t('sw.lang.language')} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {LOCALES.map((l) => {
              const on = (a.locale ?? getLocale()) === l.id
              return (
                <button key={l.id} type="button" role="radio" aria-checked={on} onClick={() => { setLocale(l.id as Locale); void answer('locale', l.id) }}
                  className={`flex h-[76px] cursor-pointer items-center justify-between rounded-2xl border px-5 text-left text-[19px] font-semibold transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7FB2FF] ${on ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.16)] shadow-[0_8px_24px_rgba(31,107,255,0.18)]' : 'border-[rgba(127,178,255,0.16)] bg-[rgba(10,24,56,0.5)] hover:border-[rgba(127,178,255,0.4)] hover:bg-[rgba(16,36,80,0.6)]'}`}>
                  {l.name}<Tick on={on} round />
                </button>
              )
            })}
          </div>
          {errOf('locale')}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        </div>
      )
      break
    case 'NETWORK_SETUP':
      content = <div className="flex flex-col gap-4"><p className="m-0 text-[15px] leading-relaxed text-[#C9D6EE]">{t('sw.net.body')}</p><Panel><FirstRunNetwork /></Panel></div>
      break
    case 'ACCOUNT_TYPE':
      content = (
        <div role="radiogroup" aria-label={stepName(state)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['personal', 'enterprise'] as const).map((k) => (
            <Choice key={k} role="radio" tall checked={a.accountType === k} onClick={() => void answer('accountType', k)}
              icon={k === 'personal' ? 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' : 'M3 21V7l9-4 9 4v14M9 21v-6h6v6'}
              title={t(`sw.type.${k}`)} hint={t(`sw.type.${k}Hint`)} />
          ))}
          {errOf('accountType')}
        </div>
      )
      break
    case 'ACCOUNT_AUTHENTICATION':
      content = (
        <Panel>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className={fieldLabel}>{t('sw.account.name')}
              <input className={field} value={a.account?.name ?? ''} autoComplete="name" onChange={(e) => void answer('account', { ...(a.account ?? {}), user: a.account?.user ?? '', name: e.target.value })} />
            </label>
            <label className={fieldLabel}>{t('sw.account.user')}
              <input className={field} value={a.account?.user ?? ''} autoComplete="username" spellCheck={false}
                onChange={(e) => void answer('account', { ...(a.account ?? {}), user: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) })} />
              {errOf('account')}
            </label>
          </div>
          <p className="m-0 mt-4 flex items-start gap-2 text-[13px] leading-snug text-[#AFC0DD]"><Icon d={['M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z']} size={15} />{t('sw.account.userHint')}</p>
        </Panel>
      )
      break
    case 'DEVICE_ENROLLMENT':
      content = (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[15px] leading-relaxed text-[#C9D6EE]">{t('sw.enroll.body')}</p>
          <Panel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className={fieldLabel}>{t('settings.enroll.server')}<input className={field} value={enroll.server} placeholder="work.example.com" onChange={(e) => setEnroll((x) => ({ ...x, server: e.target.value }))} /></label>
              <label className={fieldLabel}>{t('setup.codeOptional')}<input className={field} value={enroll.code} spellCheck={false} onChange={(e) => setEnroll((x) => ({ ...x, code: e.target.value }))} /></label>
            </div>
          </Panel>
        </div>
      )
      break
    case 'STORAGE_CONFIGURATION':
      content = (
        <div className="flex flex-col gap-4">
          <p className="m-0 flex items-start gap-3 rounded-2xl border border-[rgba(240,166,60,0.35)] bg-[rgba(240,166,60,0.1)] px-4 py-3.5 text-[14px] leading-relaxed text-[#FFD9A0]"><Icon d={['M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0z']} size={20} />{t('sw.storage.body')}</p>
          <Panel>
            <div className="flex flex-col gap-4">
              <label className={fieldLabel}>{t('sw.storage.disk')}<input className={field} value={a.disk ?? ''} spellCheck={false} onChange={(e) => void answer('disk', e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32))} />{errOf('disk')}</label>
              {a.disk && <label className={fieldLabel}>{t('sw.storage.confirm', { disk: a.disk })}<input className={field} value={a.diskConfirmed ?? ''} spellCheck={false} onChange={(e) => void answer('diskConfirmed', e.target.value.slice(0, 32))} />{errOf('diskConfirmed')}</label>}
            </div>
          </Panel>
        </div>
      )
      break
    case 'SECURITY_CONFIGURATION':
      content = (
        <div className="flex flex-col gap-2">
          <Choice role="checkbox" tall checked={!!a.encryption?.enabled} onClick={() => void answer('encryption', { enabled: !a.encryption?.enabled })}
            icon="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z" title={t('sw.sec.encrypt')} hint={t('sw.sec.encryptHint')} />
          {errOf('encryption')}
        </div>
      )
      break
    case 'WORKSUITE_APP_SELECTION': {
      const list: string[] = Array.isArray(a.worksuiteApps) ? a.worksuiteApps : []
      content = (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 max-w-[560px] text-[15px] text-[#C9D6EE]">{t('sw.apps.body')}</p>
            <span className="rounded-full bg-[rgba(127,178,255,0.12)] px-3 py-1 text-[12px] font-semibold text-[#C9D6EE]">{t('sw.selected', { n: new Set([...list, 'worksuite-desktop']).size })}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {WORKSUITE_APPS.map((id) => {
              const required = id === 'worksuite-desktop'
              const [name, desc] = split(t(`sw.app.${id}` as MessageKey))
              return <AppCard key={id} checked={required || list.includes(id)} disabled={required} onClick={() => toggle('worksuiteApps', id, list)}
                icon={<img src={APP_ICON[id]} alt="" className="size-12 rounded-xl" draggable={false} />} name={name} desc={desc} badge={required ? t('sw.apps.required') : undefined} />
            })}
          </div>
          {errOf('worksuiteApps')}
        </div>
      )
      break
    }
    case 'THIRD_PARTY_APP_SELECTION': {
      const list: string[] = Array.isArray(a.thirdPartyApps) ? a.thirdPartyApps : []
      content = (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[15px] text-[#C9D6EE]">{t('sw.third.body')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {THIRD_PARTY_APPS.map((id) => {
              const [name, desc] = split(t(`sw.third.${id}` as MessageKey))
              const [d, bg] = THIRD_LOOK[id]
              return <AppCard key={id} checked={list.includes(id)} onClick={() => toggle('thirdPartyApps', id, list)} name={name} desc={desc}
                icon={<span className="flex size-12 items-center justify-center rounded-xl text-white" style={{ background: bg }}><Icon d={[d]} size={24} /></span>} />
            })}
          </div>
        </div>
      )
      break
    }
    case 'AI_MCP_CONFIGURATION':
      content = (
        <Choice role="checkbox" tall checked={!!a.aiMcp?.enabled} onClick={() => void answer('aiMcp', { enabled: !a.aiMcp?.enabled })}
          icon="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" title={t('sw.ai.enable')} hint={t('sw.ai.enableHint')} />
      )
      break
    case 'REVIEW_CONFIGURATION':
      content = <Review answers={a} send={send} answer={answer} errOf={errOf} />
      break
  }

  const welcome = state === 'WELCOME'
  return (
    <form className="flex flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); if (!busy) void next() }}>
      <div className="flex flex-1 flex-col gap-6">
        {welcome && <div className="relative w-fit"><div aria-hidden className="absolute -inset-6 rounded-full bg-[radial-gradient(circle,rgba(31,107,255,0.35),transparent_70%)] blur-md" /><div className="relative"><Mark size={84} /></div></div>}
        <header className="flex flex-col gap-2">
          {!welcome && <p className="m-0 text-[12px] font-semibold tracking-[0.08em] text-[#7FB2FF] uppercase">{t(`sw.phase.${phaseOf(state).key}`)}</p>}
          <h1 ref={headingRef} tabIndex={-1} className={`m-0 font-bold tracking-[-0.025em] outline-none ${welcome ? 'text-[44px] leading-[1.1]' : 'text-[34px] leading-tight'}`}>{welcome ? t('sw.welcome.title') : stepName(state)}</h1>
          {SUBTITLED.has(state) && <p className="m-0 text-[17px] text-[#AFC0DD]">{t(`sw.sub.${state}` as MessageKey)}</p>}
        </header>
        {content}
        {extraError && <p role="alert" className="m-0 text-sm text-[#FFB4A6]">{extraError}</p>}
      </div>
      {/* Sticky action bar: always reachable, Enter continues. */}
      <div className="sticky bottom-0 -mx-2 mt-8 flex items-center gap-3 border-t border-[rgba(127,178,255,0.1)] bg-gradient-to-t from-[rgba(5,12,32,0.92)] to-[rgba(5,12,32,0.6)] px-2 py-4 backdrop-blur-md">
        {!first && <Button type="button" variant="secondary" size="lg" disabled={busy} onClick={() => void send({ type: 'BACK' })}>
          <Icon d={['M15 6l-6 6 6 6']} size={16} />{t('sw.back')}
        </Button>}
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="ml-auto min-w-[160px]">
          {busy ? <><Spinner size={16} />{t('sw.busy')}</> : <>{welcome ? t('sw.start') : t('sw.next')}<Icon d={['M9 6l6 6-6 6']} size={16} /></>}
        </Button>
      </div>
    </form>
  )
}

/** "Name: description" catalog strings → [name, description]. */
const split = (s: string): [string, string] => { const i = s.indexOf(':'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1).trim()] }

function Review({ answers: a, send, answer, errOf }: { answers: Record<string, any>; send: (e: SetupEvent) => Promise<boolean>; answer: (k: string, v: unknown) => Promise<boolean>; errOf: (k: string) => ReactNode }) {
  const yesNo = (b: unknown) => t(b ? 'sw.review.yes' : 'sw.review.no')
  const names = (ids: unknown, prefix: string) => Array.isArray(ids) && ids.length ? ids.map((id) => split(t(`${prefix}${id}` as MessageKey))[0]).join(', ') : t('sw.review.none')
  const groups: [string, [MainState, string, string][]][] = useMemo(() => [
    [t('sw.phase.start'), [
      ['LANGUAGE_REGION', t('sw.lang.language'), LOCALES.find((l) => l.id === a.locale)?.name ?? String(a.locale ?? '—')],
      ['LANGUAGE_REGION', t('sw.lang.timezone'), String(a.timezone ?? '—').replace(/_/g, ' ')],
      ['LANGUAGE_REGION', t('sw.lang.keyboard'), KEYBOARDS.find(([id]) => id === a.keyboard)?.[1] ?? String(a.keyboard ?? '—')],
    ]],
    [t('sw.phase.account'), [
      ['ACCOUNT_TYPE', t('sw.step.ACCOUNT_TYPE'), a.accountType ? t(`sw.type.${a.accountType as 'personal' | 'enterprise'}`) : '—'],
      ['ACCOUNT_AUTHENTICATION', t('sw.account.user'), String(a.account?.user ?? '—')],
    ]],
    [t('sw.phase.apps'), [
      ['SECURITY_CONFIGURATION', t('sw.sec.encrypt'), yesNo(a.encryption?.enabled)],
      ['WORKSUITE_APP_SELECTION', t('sw.step.WORKSUITE_APP_SELECTION'), names(a.worksuiteApps, 'sw.app.')],
      ['THIRD_PARTY_APP_SELECTION', t('sw.step.THIRD_PARTY_APP_SELECTION'), names(a.thirdPartyApps, 'sw.third.')],
      ['AI_MCP_CONFIGURATION', t('sw.ai.enable'), yesNo(a.aiMcp?.enabled)],
    ]],
  ], [a])
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([title, rows]) => (
        <section key={title} className="overflow-hidden rounded-2xl border border-[rgba(127,178,255,0.16)] bg-[rgba(10,24,56,0.5)]">
          <h2 className="m-0 border-b border-[rgba(127,178,255,0.1)] px-5 py-2.5 text-[12px] font-semibold tracking-[0.08em] text-[#7FB2FF] uppercase">{title}</h2>
          <dl className="m-0 divide-y divide-[rgba(127,178,255,0.08)]">
            {rows.map(([st, label, value]) => (
              <div key={label} className="flex items-center gap-4 px-5 py-3">
                <dt className="w-40 shrink-0 text-[13px] text-[#8FA3C8]">{label}</dt>
                <dd className="m-0 min-w-0 flex-1 text-[15px] font-medium break-words">{value}</dd>
                <Button type="button" variant="link" size="xs" onClick={() => void send({ type: 'GOTO', to: st })}>{t('sw.review.edit')}</Button>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[rgba(127,178,255,0.16)] bg-[rgba(10,24,56,0.5)] px-5 py-4 text-[15px] font-medium hover:border-[rgba(127,178,255,0.35)]">
        <input type="checkbox" className="size-5 accent-[#1F6BFF]" checked={a.reviewAccepted === true} onChange={(e) => void answer('reviewAccepted', e.target.checked)} />
        {t('sw.review.accept')}
      </label>
      {errOf('reviewAccepted')}
    </div>
  )
}

const Panel = ({ children }: { children: ReactNode }) => <div className="rounded-2xl border border-[rgba(127,178,255,0.16)] bg-[rgba(10,24,56,0.5)] p-5 shadow-[0_12px_40px_rgba(0,0,0,0.18)] backdrop-blur-sm">{children}</div>

function Tick({ on, round }: { on: boolean; round?: boolean }) {
  return (
    <span aria-hidden className={`flex size-[22px] shrink-0 items-center justify-center ${round ? 'rounded-full' : 'rounded-md'} border transition-colors ${on ? 'border-[#1F6BFF] bg-[#1F6BFF] text-white' : 'border-[rgba(127,178,255,0.4)]'}`}>
      {on && <Icon d={[CHECK]} size={13} width={3} />}
    </span>
  )
}

const cardBase = 'flex w-full cursor-pointer items-start gap-4 rounded-2xl border text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7FB2FF] disabled:cursor-default'
const cardState = (on: boolean) => on ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.14)] shadow-[0_8px_24px_rgba(31,107,255,0.16)]' : 'border-[rgba(127,178,255,0.16)] bg-[rgba(10,24,56,0.5)] hover:-translate-y-px hover:border-[rgba(127,178,255,0.4)] hover:bg-[rgba(16,36,80,0.6)] motion-reduce:hover:translate-y-0'

function Choice({ role, checked, onClick, title, hint, icon, tall }: { role: 'radio' | 'checkbox'; checked: boolean; onClick: () => void; title: string; hint?: string; icon?: string; tall?: boolean }) {
  return (
    <button type="button" role={role} aria-checked={checked} onClick={onClick} className={`${cardBase} ${cardState(checked)} ${tall ? 'p-5' : 'p-4'}`}>
      {icon && <span className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${checked ? 'bg-[#1F6BFF] text-white' : 'bg-[rgba(31,107,255,0.18)] text-[#9CC2FF]'}`}><Icon d={[icon]} size={21} /></span>}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[17px] font-semibold text-[#E8EEFA]">{title}</span>
        {hint && <span className="text-[14px] leading-snug text-[#AFC0DD]">{hint}</span>}
      </span>
      <Tick on={checked} round={role === 'radio'} />
    </button>
  )
}

function AppCard({ checked, disabled, onClick, icon, name, desc, badge }: { checked: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; name: string; desc: string; badge?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={onClick} className={`${cardBase} ${cardState(checked)} items-center p-4`}>
      <span className="shrink-0 drop-shadow-[0_4px_10px_rgba(0,0,0,0.3)]">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-[#E8EEFA]">{name}</span>
        <span className="text-[13px] leading-snug text-[#AFC0DD]">{desc}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-2 self-start">
        <Tick on={checked} />
        {badge && <span className="rounded-full bg-[rgba(46,158,106,0.22)] px-2 py-0.5 text-[11px] font-semibold text-[#8BE3B5]">{badge}</span>}
      </span>
    </button>
  )
}

/** Unattended steps: the install phase's work as a checklist, the running one highlighted. */
function WorkPanel({ api, state, flow, send, busy, headingRef }: { api: SetupApi; state: MainState; flow: MainState[]; send: (e: SetupEvent) => Promise<boolean>; busy: boolean; headingRef: HeadingRef }) {
  const work = flow.filter((s) => WORK_STATES.includes(s) && s !== 'INITIALIZING')
  const i = work.indexOf(state)
  const apps = useAppProgress(api, state === 'INSTALLING_APPLICATIONS')
  return (
    <Center>
      <InstallGraphic apps={apps} icon={(a) => <AppIcon id={a.id} size={44} />} label={t('sw.apps.title')} />
      <div role="status" aria-live="polite"><h1 ref={headingRef} tabIndex={-1} className="m-0 text-[32px] font-bold tracking-[-0.025em] outline-none">{stepName(state)}</h1></div>
      <p className="m-0 text-[15px] text-[#AFC0DD]">{t('sw.work.body')}</p>
      {state === 'INSTALLING_APPLICATIONS' && <AppRows apps={apps} />}
      {state !== 'INSTALLING_APPLICATIONS' && work.length > 1 && (
        <ol className="m-0 mt-4 flex w-full max-w-[420px] list-none flex-col gap-1 rounded-2xl border border-[rgba(127,178,255,0.14)] bg-[rgba(10,24,56,0.45)] p-3 text-left">
          {work.map((w, n) => (
            <li key={w} aria-current={n === i ? 'step' : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] ${n === i ? 'bg-[rgba(31,107,255,0.14)] font-semibold text-white' : n < i ? 'text-[#C9D6EE]' : 'text-[#8FA3C8]'}`}>
              <span aria-hidden className={`flex size-6 items-center justify-center rounded-full ${n < i ? 'bg-[#2E9E6A] text-white' : n === i ? '' : 'border border-[rgba(127,178,255,0.3)]'}`}>
                {n < i ? <Icon d={[CHECK]} size={12} width={3} /> : n === i ? <Spinner size={18} /> : null}
              </span>
              {stepName(w)}
            </li>
          ))}
        </ol>
      )}
      <Button variant="secondary" size="md" className="mt-4" disabled={busy} onClick={() => void send({ type: 'PAUSE' })}>
        <Icon d={['M8 5v14M16 5v14']} size={15} />{t('sw.pause')}
      </Button>
    </Center>
  )
}

function DonePanel({ answers, onDone, headingRef }: { answers: Record<string, unknown>; onDone: () => void; headingRef: HeadingRef }) {
  const apps = WORKSUITE_APPS.filter((id) => id === 'worksuite-desktop' || (Array.isArray(answers.worksuiteApps) && answers.worksuiteApps.includes(id)))
  return (
    <Center>
      <div className="relative mb-2 flex size-24 items-center justify-center">
        <div aria-hidden className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(46,158,106,0.45),transparent_70%)] blur-md" />
        <span className="relative flex size-20 items-center justify-center rounded-full bg-gradient-to-br from-[#2E9E6A] to-[#18D4F0] text-white shadow-[0_12px_40px_rgba(46,158,106,0.45)]"><Icon d={[CHECK]} size={40} width={2.5} /></span>
      </div>
      <h1 ref={headingRef} tabIndex={-1} className="m-0 text-[44px] leading-tight font-bold tracking-[-0.03em] outline-none">{t('sw.done.title')}</h1>
      <p className="m-0 text-[17px] text-[#AFC0DD]">{t('sw.done.body')}</p>
      <ul className="m-0 mt-3 flex list-none flex-wrap justify-center gap-3 p-0">
        {apps.map((id) => <li key={id}><img src={APP_ICON[id]} alt={split(t(`sw.app.${id}` as MessageKey))[0]} className="size-14 rounded-2xl drop-shadow-[0_6px_14px_rgba(0,0,0,0.35)]" draggable={false} /></li>)}
      </ul>
      <Button variant="primary" size="xl" className="mt-6" onClick={onDone}>{t('sw.finish')}<Icon d={['M9 6l6 6-6 6']} size={18} /></Button>
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
  const icon = state === 'PAUSED' ? 'M8 5v14M16 5v14' : state === 'CANCELLED' ? 'M6 6l12 12M18 6 6 18' : state === 'WAITING_FOR_USER' ? 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' : null
  return (
    <Center>
      {icon ? <span className="mb-2 flex size-16 items-center justify-center rounded-2xl bg-[rgba(127,178,255,0.12)] text-[#9CC2FF]"><Icon d={[icon]} size={28} /></span>
        : <div className="mb-2"><Spinner size={56} /></div>}
      <h1 ref={headingRef} tabIndex={-1} className="m-0 text-[32px] font-bold tracking-[-0.025em] outline-none">{t(`sw.side.${state}` as MessageKey)}</h1>
      {hint && <p className="m-0 text-[15px] break-words text-[#AFC0DD]">{hint}</p>}
      {state === 'WAITING_FOR_NETWORK' && <div className="mt-3 w-full text-left"><Panel><FirstRunNetwork /></Panel></div>}
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        {actions.map(([label, e, variant]) => <Button key={label} variant={variant} size="lg" disabled={busy} onClick={() => void send(e)}>{t(label)}</Button>)}
      </div>
    </Center>
  )
}

const APP_STATE_LOOK: Record<AppProgress['state'], string> = {
  pending: 'text-[#8FA3C8]', installing: 'text-[#9CC2FF]', installed: 'text-[#8BE3B5]', already: 'text-[#8BE3B5]', queued: 'text-[#FFD9A0]', failed: 'text-[#FFB4A6]', skipped: 'text-[#8FA3C8]',
}
/** Per-app progress of the app installation step (GetApps), polled while the step runs. */
function useAppProgress(api: SetupApi, on: boolean): AppProgress[] {
  const [apps, setApps] = useState<AppProgress[]>([])
  useEffect(() => {
    if (!on) return
    let alive = true
    const load = () => void api.apps().then((r) => { if (alive && r.ok) setApps(r.value) })
    load(); const id = setInterval(load, 1000)
    return () => { alive = false; clearInterval(id) }
  }, [api, on])
  return on ? apps : []
}

/** An app's own icon (WorkSuite packages) or its glyph on the brand colour (third-party). */
function AppIcon({ id, size }: { id: string; size: number }) {
  const icon = (APP_ICON as Record<string, string>)[id]
  const third = (THIRD_LOOK as Record<string, [string, string]>)[id]
  if (icon) return <img src={icon} alt="" style={{ width: size, height: size }} className="block rounded-xl" draggable={false} />
  return <span style={{ width: size, height: size, background: third?.[1] ?? '#5E739C' }} className="flex items-center justify-center rounded-xl text-white"><Icon d={[third?.[0] ?? 'M4 4h16v16H4z']} size={Math.round(size / 2)} /></span>
}

function AppRows({ apps }: { apps: AppProgress[] }) {
  if (!apps.length) return null
  const nameOf = (a: AppProgress) => {
    const k = (WORKSUITE_APPS as readonly string[]).includes(a.id) ? `sw.app.${a.id}` : (THIRD_PARTY_APPS as readonly string[]).includes(a.id) ? `sw.third.${a.id}` : null
    return k ? split(t(k as MessageKey))[0] : a.name
  }
  return (
    <section aria-label={t('sw.apps.title')} className="mt-4 w-full max-w-[460px] rounded-2xl border border-[rgba(127,178,255,0.14)] bg-[rgba(10,24,56,0.45)] p-2 text-left">
      <ul className="m-0 flex list-none flex-col p-0">
        {apps.map((a) => {
          const icon = (APP_ICON as Record<string, string>)[a.id]
          const third = (THIRD_LOOK as Record<string, [string, string]>)[a.id]
          return (
            <li key={a.id} className={`flex items-center gap-3 rounded-xl px-3 py-2 ${a.state === 'installing' ? 'bg-[rgba(31,107,255,0.12)]' : ''}`}>
              {icon ? <img src={icon} alt="" className="size-8 rounded-lg" draggable={false} />
                : <span className="flex size-8 items-center justify-center rounded-lg text-white" style={{ background: third?.[1] ?? '#5E739C' }}><Icon d={[third?.[0] ?? 'M4 4h16v16H4z']} size={16} /></span>}
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{nameOf(a)}</span>
              <span className={`flex items-center gap-1.5 text-[12px] font-medium ${APP_STATE_LOOK[a.state]}`} title={a.error ?? undefined}>
                {a.state === 'installing' && <Spinner size={13} />}
                {(a.state === 'installed' || a.state === 'already') && <Icon d={[CHECK]} size={13} width={3} />}
                {t(`sw.appState.${a.state}` as MessageKey)}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
