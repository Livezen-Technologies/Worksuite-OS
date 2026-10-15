import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FirstRunProps } from './types'
import { cloudErrorText, os, serverUrlFor, type CloudAccount } from '../lib/os'
import {
  ACCENTS, DEFAULT_APPS, DEFAULT_PRIVACY, KEYS, SETUP_APPS, THEMES, applyAppearance, loadAppearance, readyRows, writeJson,
  type Appearance, type Privacy, type Theme,
} from '../lib/setup'
import { BG, Icon, Mark, P, StepDots, ghostBtn, mono, primaryBtn } from '../components/Ws'
import { getLocale, setLocale, t as tr, type Locale, type MessageKey } from '../i18n'

// First boot: Welcome → Appearance → Privacy → WorkSuite apps (+ workspace sign-in) → Ready.
type Mode = 'personal' | 'enterprise'

const THEME_LOOK: Record<Theme, { bg: string; bar: string; win: string }> = {
  Light: { bg: 'linear-gradient(135deg,#EAF1FF,#C9DAFF)', bar: 'rgba(255,255,255,0.8)', win: '#FFFFFF' },
  Dark: { bg: 'linear-gradient(135deg,#0E2357,#060E22)', bar: 'rgba(255,255,255,0.08)', win: '#13264F' },
  Auto: { bg: 'linear-gradient(135deg,#EAF1FF 0%,#EAF1FF 50%,#0E2357 50%,#060E22 100%)', bar: 'rgba(127,178,255,0.25)', win: '#8FA3C8' },
}

const PRIVACY_ITEMS: [keyof Privacy, MessageKey, MessageKey, string][] = [
  ['location', 'setup.priv.location', 'setup.priv.locationHint', 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z'],
  ['updates', 'settings.priv.autoUpdates', 'setup.priv.updatesHint', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  ['crash', 'settings.priv.crash', 'setup.priv.crashHint', 'M4 4h16v12H5.5L4 18z'],
  ['usage', 'settings.priv.usage', 'setup.priv.usageHint', 'M4 20V10M10 20V4M16 20v-7M22 20H2'],
]

const LANGUAGES = ['English (United States)', 'English (United Kingdom)', 'සිංහල', 'தமிழ்']
const LANG_LOCALE: Record<string, Locale> = { 'English (United States)': 'en', 'English (United Kingdom)': 'en', 'සිංහල': 'si', 'தமிழ்': 'ta' }
const REGIONS: MessageKey[] = ['setup.region.lk', 'setup.region.in', 'setup.region.uk', 'setup.region.us']

const field = 'h-11 w-full rounded-[10px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3.5 text-[15px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8] focus:border-[#1F6BFF] disabled:opacity-60'
const fieldLabel = 'flex flex-col gap-1.5 text-[13px] font-semibold text-[#C9D6EE]'

export default function FirstRun({ onDone, userName }: FirstRunProps) {
  const [step, setStep] = useState(0)
  const [lang, setLang] = useState(() => LANGUAGES.find((l) => LANG_LOCALE[l] === getLocale()) ?? LANGUAGES[0])
  const [region, setRegion] = useState(REGIONS[0])
  const [langOpen, setLangOpen] = useState(false)
  const [look, setLook] = useState<Appearance>(() => loadAppearance())
  const [privacy, setPrivacy] = useState<Privacy>(DEFAULT_PRIVACY)
  const [apps, setApps] = useState<string[]>(DEFAULT_APPS)
  // WorkSuite workspace: connect (+ optional enrollment), then OneAuth in the system browser.
  const [panel, setPanel] = useState(false)
  const [mode, setMode] = useState<Mode>('enterprise')
  const [server, setServer] = useState('')
  const [code, setCode] = useState('')
  const [enrolled, setEnrolled] = useState<{ org_name: string | null } | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [signedIn, setSignedIn] = useState<CloudAccount | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => { headingRef.current?.focus() }, [step])

  const pickLook = (a: Appearance) => { setLook(a); applyAppearance(a); writeJson(KEYS.appearance, a) }
  const finish = () => {
    writeJson(KEYS.privacy, privacy)
    writeJson(KEYS.apps, apps)
    onDone()
  }

  const enroll = async () => {
    if (mode === 'enterprise' && !server.trim()) return setError(tr('setup.enterServer'))
    setError(null); setEnrolling(true)
    const r = await os.enrollDevice(serverUrlFor(mode, server), code)
    setEnrolling(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    setEnrolled({ org_name: r.value.org_name })
  }

  // OIDC + PKCE happens in the system browser through the credentials broker (WSOS-IDN-001); no password here.
  const signIn = async () => {
    if (mode === 'enterprise' && !server.trim()) return setError(tr('setup.enterServer'))
    // Enrollment is optional (WSOS-INS-006); with a code it runs first. Organizations that require it refuse sign-in until it's done.
    if (mode === 'enterprise' && code.trim() && !enrolled) return void enroll()
    setError(null); setWaiting(true)
    const r = await os.cloudSignIn(serverUrlFor(mode, server), mode)
    setWaiting(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    setSignedIn(r.value); setPanel(false)
  }

  const greeting = userName ? tr('setup.hiName', { name: userName }) : tr('setup.hi')

  if (step === 0) return (
    <Screen bg={BG.setupCenter} center>
      <div className="absolute top-7 right-10">
        <button type="button" aria-expanded={langOpen} aria-controls="ws-lang" onClick={() => setLangOpen((v) => !v)}
          className="cursor-pointer rounded-lg px-3 py-1.5 text-sm text-[#C9D6EE] hover:bg-white/5">{lang} · {tr(region)}</button>
        {langOpen && (
          <div id="ws-lang" role="group" aria-label={tr('setup.langRegion')} className="absolute top-11 right-0 z-10 flex w-72 flex-col gap-3 rounded-2xl border border-[rgba(127,178,255,0.18)] bg-[rgba(10,24,56,0.97)] p-4 shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
            <label className={fieldLabel}>{tr('a11y.language')}
              <select value={lang} onChange={(e) => { setLang(e.target.value); setLocale(LANG_LOCALE[e.target.value] ?? 'en') }} className={field}>{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</select>
            </label>
            <label className={fieldLabel}>{tr('setup.region')}
              <select value={region} onChange={(e) => setRegion(e.target.value as MessageKey)} className={field}>{REGIONS.map((l) => <option key={l} value={l}>{tr(l)}</option>)}</select>
            </label>
            <button type="button" onClick={() => setLangOpen(false)} className={`${ghostBtn} !py-2 text-sm`}>{tr('common.done')}</button>
          </div>
        )}
      </div>
      <Mark size={96} />
      <div className="mt-5 text-lg text-[#8FA3C8]">{greeting}</div>
      <h1 ref={headingRef} tabIndex={-1} className="m-0 text-center text-[52px] leading-tight font-bold tracking-[-0.03em] outline-none">{tr('setup.welcome')}</h1>
      <p className="m-0 max-w-[560px] text-center text-[17px] leading-normal text-[#8FA3C8]">{tr('setup.welcomeSub')}</p>
      <button type="button" onClick={() => setStep(1)} className="mt-7 flex cursor-pointer items-center gap-2.5 rounded-xl bg-[#1F6BFF] px-10 py-[15px] text-base font-semibold text-white shadow-[0_10px_30px_rgba(31,107,255,0.4)] hover:bg-[#3A7DFF]">
        {tr('setup.getStarted')}<Icon d={P.arrow} size={18} width={2.5} />
      </button>
      <button type="button" onClick={finish} className="cursor-pointer rounded-lg p-2.5 text-sm text-[#8FA3C8] hover:text-[#E8EEFA]">{tr('setup.skip')}</button>
      <div className="mt-10"><StepDots step={0} /></div>
    </Screen>
  )

  if (step === 4) {
    const rows = readyRows(apps)
    return (
      <Screen bg={BG.setupCenter} center>
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-[rgba(95,211,154,0.14)] shadow-[0_0_0_10px_rgba(95,211,154,0.06)]">
          <Icon d={P.check} size={48} stroke="#5FD39A" width={2.5} />
        </div>
        <h1 ref={headingRef} tabIndex={-1} className="mt-4 mb-0 text-[44px] leading-tight font-bold tracking-[-0.02em] outline-none">{tr('setup.allSet')}</h1>
        <p className="m-0 text-base text-[#8FA3C8]">
          {rows.length ? tr('setup.queuedApps') : tr('setup.addLater')}
        </p>
        {rows.length > 0 && (
          <ul aria-label={tr('setup.installs')} className="m-0 mt-3 flex w-[460px] max-w-full list-none flex-col gap-2.5 p-0">
            {rows.map((a) => (
              <li key={a.id} className="flex items-center gap-3.5 rounded-xl border border-[rgba(127,178,255,0.14)] bg-[rgba(14,32,72,0.6)] px-4 py-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: a.color }}>{a.initial}</span>
                <span className="w-[70px] text-sm font-medium">{a.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-[rgba(127,178,255,0.15)]" role="progressbar" aria-label={tr('setup.installOf', { name: a.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={a.percent} aria-valuetext={a.label}>
                  <span className="block h-full rounded-[3px] bg-[linear-gradient(90deg,#1F6BFF,#18D4F0)]" style={{ width: `${a.percent}%` }} />
                </span>
                <span className={`w-[52px] text-right text-xs text-[#8FA3C8] ${mono}`}>{a.label}</span>
              </li>
            ))}
          </ul>
        )}
        {!signedIn && <p className="m-0 text-[13px] text-[#8FA3C8]">{tr('setup.notSignedIn')}</p>}
        <button type="button" onClick={finish} className="mt-6 cursor-pointer rounded-xl bg-[#1F6BFF] px-10 py-[15px] text-base font-semibold text-white shadow-[0_10px_30px_rgba(31,107,255,0.4)] hover:bg-[#3A7DFF]">{tr('setup.goDesktop')}</button>
      </Screen>
    )
  }

  const head: Record<number, [string, string, number]> = {
    1: [tr('setup.look'), tr('setup.lookSub'), 36],
    2: [tr('setup.privacy'), tr('setup.privacySub'), 32],
    3: [tr('setup.apps'), tr('setup.appsSub'), 32],
  }
  const [title, sub, gap] = head[step]

  let body: ReactNode
  if (step === 1) body = (
    <>
      <div role="radiogroup" aria-label={tr('settings.app.theme')} className="grid w-[900px] max-w-full grid-cols-3 gap-6">
        {THEMES.map((t) => {
          const on = look.theme === t, l = THEME_LOOK[t]
          return (
            <button key={t} type="button" role="radio" aria-checked={on} onClick={() => pickLook({ ...look, theme: t })}
              className="flex cursor-pointer flex-col gap-3 rounded-2xl border-2 bg-[rgba(14,32,72,0.5)] p-3 text-left hover:bg-[rgba(14,32,72,0.75)]"
              style={{ borderColor: on ? '#1F6BFF' : 'transparent' }}>
              <span className="relative block h-[170px] overflow-hidden rounded-[10px]" style={{ background: l.bg }}>
                <span className="absolute right-3 bottom-2.5 left-3 h-[26px] rounded-lg" style={{ background: l.bar }} />
                <span className="absolute top-5 left-5 h-[84px] w-[120px] rounded-lg shadow-[0_6px_16px_rgba(0,0,0,0.25)]" style={{ background: l.win }} />
                <span className="absolute top-[30px] left-7 h-2 w-[60px] rounded" style={{ background: 'var(--color-ws-accent, #1F6BFF)' }} />
              </span>
              <span className="flex h-5 items-center justify-between px-1">
                <span className="text-[15px] font-semibold">{tr(`settings.theme.${t}` as MessageKey)}</span>
                {on && <svg width="20" height="20" viewBox="0 0 24 24" fill="#1F6BFF" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" /></svg>}
              </span>
            </button>
          )
        })}
      </div>
      <div role="radiogroup" aria-label={tr('settings.app.accent')} className="flex items-center gap-[18px]">
        <span className="text-sm text-[#C9D6EE]">{tr('settings.app.accent')}</span>
        {ACCENTS.map((a) => {
          const on = look.accent === a.name
          return <button key={a.name} type="button" role="radio" aria-checked={on} aria-label={tr(`settings.accent.${a.name}` as MessageKey)} onClick={() => pickLook({ ...look, accent: a.name })}
            className="h-7 w-7 cursor-pointer rounded-full" style={{ background: a.color, boxShadow: on ? '0 0 0 3px #0A1A3D, 0 0 0 5px #FFFFFF' : 'none' }} />
        })}
      </div>
    </>
  )
  else if (step === 2) body = (
    <>
      <div className="w-[720px] max-w-full overflow-hidden rounded-2xl border border-[rgba(127,178,255,0.16)] bg-[rgba(14,32,72,0.6)]">
        {PRIVACY_ITEMS.map(([k, t, d, icon], i) => {
          const on = privacy[k]
          return (
            <label key={k} className={`relative flex cursor-pointer items-center gap-[18px] px-[22px] py-[18px] focus-within:bg-white/[0.03] ${i ? 'border-t border-[rgba(127,178,255,0.1)]' : ''}`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(31,107,255,0.15)]"><Icon d={[icon]} stroke="#7FB2FF" /></span>
              <span className="flex flex-1 flex-col gap-[3px]">
                <span className="text-[15px] font-semibold">{tr(t)}</span>
                <span className="text-[13px] text-[#8FA3C8]">{tr(d)}</span>
              </span>
              <input type="checkbox" role="switch" checked={on} onChange={() => setPrivacy((p) => ({ ...p, [k]: !on }))} className="peer absolute h-px w-px opacity-0" />
              <span aria-hidden="true" className="relative h-[26px] w-11 shrink-0 rounded-[13px] transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#7FB2FF]" style={{ background: on ? '#1F6BFF' : 'rgba(127,178,255,0.25)' }}>
                <span className="absolute top-[3px] h-5 w-5 rounded-full bg-white transition-[left]" style={{ left: on ? 21 : 3 }} />
              </span>
            </label>
          )
        })}
      </div>
      <a href="https://worksuitecloud.com/privacy" onClick={(e) => { e.preventDefault(); void os.openLink('https://worksuitecloud.com/privacy') }} className="text-sm text-[#7FB2FF] hover:text-[#B8D4FF]">{tr('setup.privacyLink')}</a>
    </>
  )
  else body = (
    <>
      <div className="grid w-[900px] max-w-full grid-cols-3 gap-4">
        {SETUP_APPS.map((a) => {
          const on = apps.includes(a.id)
          return (
            <label key={a.id} className="flex cursor-pointer items-center gap-3.5 rounded-[14px] border p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[#7FB2FF]"
              style={{ borderColor: on ? 'rgba(31,107,255,0.6)' : 'rgba(127,178,255,0.16)', background: on ? 'rgba(31,107,255,0.1)' : 'rgba(14,32,72,0.6)' }}>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] text-[17px] font-bold text-white" style={{ background: a.color }}>{a.name[0]}</span>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{a.name}</span>
                <span className="text-xs text-[#8FA3C8]">{a.desc}</span>
              </span>
              <input type="checkbox" checked={on} aria-label={a.name} onChange={() => setApps((s) => on ? s.filter((x) => x !== a.id) : [...s, a.id])} className="h-5 w-5 cursor-pointer accent-[#1F6BFF] focus-visible:outline-none" />
            </label>
          )
        })}
      </div>
      <div className="flex w-[900px] max-w-full items-center gap-4 rounded-[14px] border border-[rgba(127,178,255,0.16)] bg-[rgba(14,32,72,0.6)] px-5 py-[18px]">
        {signedIn ? <Icon d={P.check} size={22} stroke="#5FD39A" /> : <Icon d={P.person} size={22} stroke="#18D4F0"><circle cx="12" cy="8" r="4" /></Icon>}
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{signedIn ? (signedIn.name ? tr('setup.signedInAs', { name: signedIn.name }) : tr('settings.signedIn')) : tr('setup.signInWs')}</span>
          <span className="text-[13px] text-[#8FA3C8]">{signedIn ? tr('setup.syncFrom', { host: hostOf(signedIn.server_url) }) : tr('setup.syncHint')}</span>
        </span>
        {!signedIn && <button type="button" aria-haspopup="dialog" onClick={() => { setError(null); setPanel(true) }} className="cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.3)] px-[18px] py-2.5 text-sm font-semibold text-[#E8EEFA] hover:bg-white/5">{tr('greeter.signIn')}</button>}
      </div>
    </>
  )

  return (
    <Screen bg={BG.setupTop}>
      <div className="flex flex-col items-center gap-2.5">
        <div className={`text-xs tracking-[0.08em] text-[#18D4F0] ${mono}`}>{tr('setup.stepOf', { n: step + 1, total: 5 })}</div>
        <h1 ref={headingRef} tabIndex={-1} className="m-0 text-4xl leading-tight font-bold tracking-[-0.02em] outline-none">{title}</h1>
        <p className="m-0 text-[15px] text-[#8FA3C8]">{sub}</p>
      </div>
      <div className="flex w-full flex-col items-center" style={{ gap }}>{body}</div>
      <div className="mt-auto flex w-[900px] max-w-full items-center justify-between">
        <button type="button" onClick={() => setStep(step - 1)} className={ghostBtn}>{tr('common.back')}</button>
        <StepDots step={step} />
        <button type="button" onClick={() => setStep(step + 1)} className={primaryBtn}>
          {step === 3 ? (apps.length === 1 ? tr('setup.installOne') : apps.length ? tr('setup.installMany', { count: apps.length }) : tr('common.continue')) : tr('common.next')}
        </button>
      </div>

      {panel && (
        <WorkspaceDialog onClose={() => setPanel(false)}>
          <h2 id="ws-connect-title" className="m-0 text-[22px] font-bold">{tr('setup.signInWs')}</h2>
          <div role="radiogroup" aria-label={tr('setup.mode')} className="grid grid-cols-2 gap-3">
            {([
              ['personal', tr('setup.personal'), tr('setup.personalHint')],
              ['enterprise', tr('setup.enterprise'), tr('setup.enterpriseHint')],
            ] as const).map(([id, t, d]) => {
              const on = mode === id
              return (
                <button key={id} type="button" role="radio" aria-checked={on} disabled={!!enrolled || waiting} onClick={() => { setMode(id); setError(null) }}
                  className="flex cursor-pointer flex-col gap-1.5 rounded-[14px] border p-4 text-left disabled:cursor-default"
                  style={{ borderColor: on ? 'rgba(31,107,255,0.6)' : 'rgba(127,178,255,0.16)', background: on ? 'rgba(31,107,255,0.1)' : 'rgba(14,32,72,0.6)' }}>
                  <span className="text-[15px] font-semibold">{t}</span>
                  <span className="text-[13px] leading-snug text-[#8FA3C8]">{d}</span>
                </button>
              )
            })}
          </div>
          {mode === 'enterprise' && (
            <>
              <label className={fieldLabel}>{tr('settings.enroll.server')}
                <input type="text" value={server} disabled={!!enrolled || waiting} placeholder="work.example.com" spellCheck={false} onChange={(e) => { setServer(e.target.value); setError(null) }} className={field} />
              </label>
              <label className={fieldLabel}>{tr('setup.codeOptional')}
                <input type="text" value={code} disabled={!!enrolled || waiting} autoComplete="off" spellCheck={false} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null) }} className={`${field} ${mono} tracking-[1px]`} />
              </label>
            </>
          )}
          <div aria-live="polite" className="text-[13px] leading-normal text-[#8FA3C8]">
            {enrolled ? (
              <p className="m-0 flex items-start gap-2 rounded-[10px] bg-[rgba(95,211,154,0.1)] px-3.5 py-3 text-[#A7EBC8]"><Icon d={P.check} size={18} stroke="#5FD39A" className="mt-px shrink-0" />{tr('setup.enrolled', { org: enrolled.org_name ?? tr('settings.about.yourOrg') })}</p>
            ) : mode === 'enterprise' && code.trim() ? (
              <p className="m-0">{tr('setup.enrollHint')}</p>
            ) : waiting ? (
              <p className="m-0 text-[#7FB2FF]">{tr('setup.finishBrowser')}</p>
            ) : (
              <p className="m-0">{mode === 'enterprise' ? tr('setup.browserOrg') : tr('setup.browserCloud')}</p>
            )}
          </div>
          {error && <div role="alert" className="flex items-center gap-2 text-[13px] text-[#FFB4A8]"><Icon d={P.alert} size={16} />{error}</div>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setPanel(false)} className={ghostBtn}>{tr('common.notNow')}</button>
            <button type="button" disabled={waiting || enrolling} onClick={() => void signIn()} className={primaryBtn}>
              {mode === 'enterprise' && code.trim() && !enrolled ? (enrolling ? tr('settings.enroll.busy') : tr('setup.enrollComputer')) : waiting ? tr('setup.waitingBrowser') : tr('setup.signInBrowser')}
            </button>
          </div>
        </WorkspaceDialog>
      )}
    </Screen>
  )
}

function Screen({ bg, center, children }: { bg: string; center?: boolean; children: ReactNode }) {
  return (
    <main className={`relative flex h-full w-full flex-col items-center overflow-auto font-sans text-[#E8EEFA] ${center ? 'justify-center gap-[18px] p-4' : 'gap-8 px-4 pt-16 pb-12'}`} style={{ background: bg }}>
      {children}
    </main>
  )
}

function WorkspaceDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"], input, button')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-[rgba(2,6,16,0.62)] p-4 backdrop-blur-[8px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ws-connect-title"
        className="flex w-[560px] max-w-full flex-col gap-[18px] rounded-[20px] border border-[rgba(127,178,255,0.18)] bg-[#0C1E46] p-8 shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        {children}
      </div>
    </div>
  )
}

function hostOf(url: string) { try { return new URL(url).host } catch { return url } }
