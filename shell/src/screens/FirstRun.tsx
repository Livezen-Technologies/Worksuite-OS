import { useState, type ReactNode } from 'react'
import type { FirstRunProps } from './types'
import { cloudErrorText, os, serverUrlFor, type CloudAccount } from '../lib/os'
import { AIconCheck, AIconWifi, AIconAlert } from '../components/AIcons'

const STEPS = ['Language & region', 'Network', 'Connect to WorkSuite', 'Sign in with OneAuth', 'Privacy & updates'] as const
type Mode = 'personal' | 'enterprise'

const NETWORKS = [
  { ssid: 'Livezen-Office', secure: true, strength: 'Strong' },
  { ssid: 'Livezen-Guest', secure: false, strength: 'Good' },
  { ssid: 'Wired connection', secure: false, strength: 'Ethernet' },
]

const input = 'h-[46px] rounded-[10px] border border-[#cbd5e1] px-3.5 text-[15px] font-normal text-[#0f172a] outline-none focus:border-[#2563eb] focus:ring-1 focus:ring-[#2563eb]'
const label = 'flex flex-col gap-1.5 text-[13px] font-semibold text-[#334155]'

export default function FirstRun({ onDone }: FirstRunProps) {
  const [step, setStep] = useState(0)
  const [lang, setLang] = useState('English (United States)')
  const [region, setRegion] = useState('Sri Lanka')
  const [network, setNetwork] = useState<string | null>('Livezen-Office')
  const [mode, setMode] = useState<Mode>('enterprise')
  const [server, setServer] = useState('')
  const [code, setCode] = useState('')
  const [enrolled, setEnrolled] = useState<{ org_name: string | null } | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [signedIn, setSignedIn] = useState<CloudAccount | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [privacy, setPrivacy] = useState({ updates: true, diagnostics: false, location: false })

  const go = (n: number) => { setError(null); setStep(n) }
  const skipOffline = () => { setOffline(true); go(4) }

  const next = () => {
    if (step === 2 && mode === 'enterprise' && !server.trim()) return setError('Enter your organization’s server address.')
    // Enrollment is optional here (WSOS-INS-006); organizations that require it refuse sign-in until it's done.
    if (step === 2 && mode === 'enterprise' && code.trim() && !enrolled) return void enroll()
    if (step === 3 && !signedIn) return void signIn()
    if (step === 4) return onDone()
    go(step + 1)
  }

  const enroll = async () => {
    setError(null); setEnrolling(true)
    const r = await os.enrollDevice(serverUrlFor(mode, server), code)
    setEnrolling(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    setEnrolled({ org_name: r.value.org_name })
  }

  // OIDC + PKCE happens in the system browser through the credentials broker (WSOS-IDN-001); no password here.
  const signIn = async () => {
    setError(null); setWaiting(true)
    const r = await os.cloudSignIn(serverUrlFor(mode, server), mode)
    setWaiting(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    setSignedIn(r.value); setOffline(false)
  }

  const primary = ['Continue', 'Continue', mode === 'enterprise' && code.trim() && !enrolled ? (enrolling ? 'Enrolling…' : 'Enroll this computer') : 'Continue to sign-in', signedIn ? 'Continue' : waiting ? 'Waiting for browser…' : 'Sign in with browser', 'Finish setup'][step]
  const heading: [string, string][] = [
    ['Choose your language', 'Pick the language and region for this computer.'],
    ['Connect to a network', 'A connection lets you sign in to WorkSuite and get updates. You can also continue offline.'],
    ['How will you use WorkSuite?', 'Choose where this computer gets your apps, files and sign-in.'],
    ['Sign in with OneAuth', mode === 'enterprise' ? `Use your ${server || 'organization'} account.` : 'Use your WorkSuite Cloud account.'],
    ['Privacy & updates', 'Choose what this computer shares. You can change these later in Settings › Privacy.'],
  ]

  let body: ReactNode
  if (step === 0) body = (
    <div className="flex flex-col gap-5">
      <label className={label}>Language
        <select value={lang} onChange={(e) => setLang(e.target.value)} className={`${input} bg-white`}>
          {['English (United States)', 'English (United Kingdom)', 'සිංහල', 'தமிழ்'].map((l) => <option key={l}>{l}</option>)}
        </select>
      </label>
      <label className={label}>Region
        <select value={region} onChange={(e) => setRegion(e.target.value)} className={`${input} bg-white`}>
          {['Sri Lanka', 'India', 'United Kingdom', 'United States'].map((l) => <option key={l}>{l}</option>)}
        </select>
      </label>
    </div>
  )
  else if (step === 1) body = (
    <div role="radiogroup" aria-label="Available networks" className="flex flex-col gap-2">
      {NETWORKS.map((n) => {
        const on = network === n.ssid
        return (
          <label key={n.ssid} className={`flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 ${on ? 'border-2 border-[#2563eb] bg-[#eff6ff]' : 'border border-[#e2e8f0] hover:bg-[#f8fafc]'}`}>
            <input type="radio" name="a-net" checked={on} onChange={() => setNetwork(n.ssid)} className="h-[18px] w-[18px] accent-[#2563eb]" />
            <AIconWifi size={18} className="text-[#334155]" />
            <span className="flex-1 text-[15px] font-medium">{n.ssid}</span>
            <span className="text-[13px] text-[#475569]">{n.secure ? 'Secured · ' : ''}{n.strength}</span>
          </label>
        )
      })}
      <label className="mt-2 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[#cbd5e1] px-4 py-3">
        <input type="radio" name="a-net" checked={network === null} onChange={() => setNetwork(null)} className="h-[18px] w-[18px] accent-[#2563eb]" />
        <span className="text-[15px]">Continue without a network</span>
      </label>
    </div>
  )
  else if (step === 2) body = (
    <>
      <div role="radiogroup" aria-label="Connection mode" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {([
          ['personal', 'Personal', 'Sign in to WorkSuite Cloud at worksuitecloud.com. Free WorkSuite Professional includes 2 GB Drive.'],
          ['enterprise', 'Enterprise', 'Connect to your organization’s own WorkSuite server. Your IT team may manage this device.'],
        ] as const).map(([id, title, desc]) => {
          const on = mode === id
          return (
            <label key={id} className={`flex cursor-pointer flex-col gap-2.5 rounded-[14px] p-5 ${on ? 'border-2 border-[#2563eb] bg-[#eff6ff]' : 'border border-[#e2e8f0] bg-white hover:bg-[#f8fafc]'}`}>
              <span className="flex items-center gap-2.5">
                <input type="radio" name="a-mode" checked={on} onChange={() => { setMode(id); setError(null) }} className="m-0 h-[18px] w-[18px] accent-[#2563eb]" />
                <span className="text-base font-semibold">{title}</span>
                {on && <span className="ml-auto rounded-full bg-[#dbeafe] px-2 py-0.5 text-[11px] text-[#1e40af]">Selected</span>}
              </span>
              <span className={`text-sm leading-normal ${on ? 'text-[#334155]' : 'text-[#475569]'}`}>{desc}</span>
            </label>
          )
        })}
      </div>
      {mode === 'enterprise' && (
        <>
          <label className={label}>Server address
            <input type="text" value={server} disabled={!!enrolled} placeholder="work.example.com" onChange={(e) => { setServer(e.target.value); setError(null) }} className={`${input} disabled:bg-[#f8fafc]`} spellCheck={false} />
          </label>
          <label className={label}>Enrollment code (from your IT admin, optional)
            <input type="text" value={code} disabled={!!enrolled} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null) }} autoComplete="off" className={`${input} w-[280px] max-w-full font-mono tracking-[1px] disabled:bg-[#f8fafc]`} spellCheck={false} />
          </label>
          <div aria-live="polite">
            {enrolled ? (
              <div className="flex items-start gap-2.5 rounded-[10px] bg-[#ecfdf5] px-3.5 py-3 text-[13px] leading-normal text-[#065f46]">
                <AIconCheck size={18} className="mt-px shrink-0" />
                <span>This computer is now managed by {enrolled.org_name ?? 'your organization'}. You can see what that means in Settings › About this device. Sign in with OneAuth next.</span>
              </div>
            ) : code.trim() ? (
              <p className="m-0 text-[13px] text-[#475569]">Enrolling lets your organization apply its policies, updates and remote lock or wipe to this computer. An administrator password is needed.</p>
            ) : (
              <p className="m-0 text-[13px] text-[#475569]">No code? Continue without enrolling. If your organization requires enrollment, sign-in will tell you.</p>
            )}
          </div>
        </>
      )}
    </>
  )
  else if (step === 3) body = (
    <div className="flex max-w-[460px] flex-col gap-4" aria-live="polite">
      {signedIn ? (
        <p className="m-0 flex items-center gap-2.5 rounded-[10px] bg-[#ecfdf5] px-3.5 py-3 text-[14px] text-[#065f46]">
          <AIconCheck size={18} /> Signed in{signedIn.name ? ` as ${signedIn.name}` : ''}. This computer now uses your WorkSuite account.
        </p>
      ) : (
        <>
          <p className="m-0 text-[15px] text-[#334155]">
            Your browser opens the {mode === 'enterprise' ? 'organization' : 'WorkSuite Cloud'} sign-in page. Your password and any
            two-step check go to OneAuth only; this setup never sees them.
          </p>
          <p className="m-0 text-[13px] text-[#475569]">Server: {serverUrlFor(mode, server)}</p>
          {waiting && <p className="m-0 text-[13px] text-[#1d4ed8]">Finish signing in in the browser window, then come back here.</p>}
        </>
      )}
    </div>
  )
  else body = (
    <div className="flex flex-col gap-3">
      {offline && <p className="m-0 rounded-[10px] bg-[#fffbeb] px-3.5 py-3 text-[13px] text-[#92400e]">Using this computer offline. Connect later from Settings › Accounts.</p>}
      {([
        ['updates', 'Install security updates automatically', 'Recommended. Updates install when you restart.'],
        ['diagnostics', 'Send diagnostic data', 'Helps improve WorkSuite OS. No file contents are sent.'],
        ['location', 'Allow location services', 'Used for time zone and nearby printers.'],
      ] as const).map(([k, t, d]) => (
        <label key={k} className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#e2e8f0] px-4 py-3 hover:bg-[#f8fafc]">
          <input type="checkbox" checked={privacy[k]} onChange={(e) => setPrivacy((p) => ({ ...p, [k]: e.target.checked }))} className="mt-0.5 h-[18px] w-[18px] accent-[#2563eb]" />
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-medium">{t}</span>
            <span className="text-[13px] text-[#475569]">{d}</span>
          </span>
        </label>
      ))}
    </div>
  )

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-[#f1f5f9] p-4 text-[#0f172a]">
      <div className="flex h-[680px] max-h-full w-[1040px] max-w-full overflow-hidden rounded-[20px] border border-[#e2e8f0] bg-white shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
        <aside className="hidden w-[280px] shrink-0 flex-col gap-6 border-r border-[#e2e8f0] bg-[#f8fafc] px-6 py-8 md:flex">
          <div className="flex items-center gap-2.5 text-[15px] font-semibold">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-[#2563eb] font-bold text-white">W</span>
            Set up WorkSuite OS
          </div>
          <ol aria-label="Setup steps" className="m-0 flex list-none flex-col gap-1 p-0">
            {STEPS.map((s, i) => {
              const done = i < step, now = i === step
              return (
                <li key={s} aria-current={now ? 'step' : undefined}>
                  <button type="button" disabled={i > step} onClick={() => go(i)}
                    className={`flex h-11 w-full items-center gap-3 rounded-[10px] px-2.5 text-left disabled:cursor-default ${now ? 'bg-[#eff6ff]' : done ? 'hover:bg-[#f1f5f9]' : ''}`}>
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-[#dcfce7] text-[#15803d]' : now ? 'bg-[#2563eb] text-white' : 'bg-[#e2e8f0] text-[#475569]'}`}>
                      {done ? <AIconCheck size={14} strokeWidth={3} /> : i + 1}
                    </span>
                    <span className={`text-sm ${now ? 'font-semibold text-[#0f172a]' : done ? 'text-[#334155]' : 'text-[#475569]'}`}>{s}</span>
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="mt-auto text-xs leading-normal text-[#475569]">You can skip WorkSuite sign-in and use this computer offline. Connect later from Settings › Accounts.</div>
        </aside>

        <form onSubmit={(e) => { e.preventDefault(); next() }} noValidate className="flex min-w-0 flex-1 flex-col gap-5 overflow-auto px-6 py-8 md:px-12 md:py-10">
          <div className="flex flex-col gap-1.5">
            <div className="text-[13px] text-[#475569]">Step {step + 1} of {STEPS.length}</div>
            <h1 className="m-0 text-[28px] font-[650] tracking-[-0.5px]">{heading[step][0]}</h1>
            <p className="m-0 text-[15px] text-[#475569]">{heading[step][1]}</p>
          </div>
          {body}
          {error && <div role="alert" className="flex items-center gap-2 text-[13px] text-[#b91c1c]"><AIconAlert />{error}</div>}
          <div className="mt-auto flex flex-wrap items-center gap-2.5 pt-2">
            {step > 0 && (
              <button type="button" onClick={() => go(offline && step === 4 ? 2 : step - 1)}
                className="h-11 rounded-[10px] border border-[#cbd5e1] bg-white px-[18px] text-sm text-[#334155] hover:bg-[#f8fafc]">Back</button>
            )}
            {(step === 2 || step === 3) && (
              <button type="button" onClick={skipOffline} className="h-11 rounded-[10px] px-[18px] text-sm text-[#334155] underline hover:text-[#0f172a]">Skip — use offline</button>
            )}
            <button type="submit" disabled={waiting || enrolling} className="ml-auto h-11 rounded-[10px] bg-[#2563eb] px-[22px] text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-60">{primary}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
