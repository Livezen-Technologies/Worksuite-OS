import { useEffect, useMemo, useState } from 'react'
import type { InstallerProps } from './types'
import CIcon from '../components/CIcon'

const STEPS = ['Language', 'Keyboard', 'Disk', 'Encryption', 'Account', 'Install', 'Done'] as const
const DISKS = [
  { id: 'nvme0n1', name: 'Samsung SSD 980', size: '512 GB', path: '/dev/nvme0n1', note: 'contains Windows 11 (3 partitions)', available: true },
  { id: 'sda', name: 'Kingston DataTraveler', size: '32 GB', path: '/dev/sda', note: 'the installer is running from this drive', available: false },
]
const LANGS = ['English (United States)', 'English (United Kingdom)', 'Deutsch', 'Français', 'Español', 'Sinhala']
const LAYOUTS = ['English (US)', 'English (UK)', 'German (QWERTZ)', 'French (AZERTY)', 'Spanish']

function makeKey() {
  const a = new Uint16Array(8)
  try { crypto.getRandomValues(a) } catch { a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 65536))) }
  return Array.from(a, (n) => n.toString().padStart(6, '0').slice(0, 6)).join('-')
}

const input = 'h-11 w-full max-w-[360px] rounded-[10px] border border-slate-300 bg-white px-3.5 text-[15px] text-slate-900'
const field = 'flex flex-col gap-1.5 text-[13px] font-semibold text-slate-700'

export default function Installer({ onDone }: InstallerProps) {
  const [step, setStep] = useState(0)
  const [lang, setLang] = useState(LANGS[0])
  const [layout, setLayout] = useState(LAYOUTS[0])
  const [test, setTest] = useState('')
  const [disk, setDisk] = useState(DISKS[0].id)
  const [confirm, setConfirm] = useState('')
  const [encrypt, setEncrypt] = useState(true)
  const [join, setJoin] = useState(true)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [keyHidden, setKeyHidden] = useState(false)
  const recoveryKey = useMemo(makeKey, [])
  const [acct, setAcct] = useState({ name: '', user: '', pw: '', pw2: '', host: 'LZT-LAP-0143' })
  const [progress, setProgress] = useState(0)

  const target = DISKS.find((d) => d.id === disk)!
  const diskOk = confirm.trim() === target.name
  const encOk = !encrypt || (pass.length >= 8 && pass === pass2 && keySaved)
  const acctOk = acct.name.trim() && /^[a-z][a-z0-9-]{1,31}$/.test(acct.user) && acct.pw.length >= 8 && acct.pw === acct.pw2

  const LOG = ['Partitioning disk', encrypt ? 'Setting up LUKS2 encryption' : 'Formatting partitions', 'Copying system files', 'Installing WorkSuite desktop', 'Configuring bootloader', 'Creating administrator account', 'Finishing up']
  useEffect(() => {
    if (STEPS[step] !== 'Install') return
    const id = setInterval(() => setProgress((p) => { const n = Math.min(100, p + 2); if (n >= 100) clearInterval(id); return n }), 120)
    return () => clearInterval(id)
  }, [step])
  useEffect(() => { if (progress >= 100 && STEPS[step] === 'Install') setStep(6) }, [progress, step])

  // Recovery key is displayed exactly once: hide it after leaving the step.
  const next = () => { if (STEPS[step] === 'Encryption' && encrypt) setKeyHidden(true); setStep((s) => s + 1) }

  const canNext = [true, true, diskOk, encOk, !!acctOk, false, true][step]
  const nextLabel = STEPS[step] === 'Account' ? 'Install' : STEPS[step] === 'Disk' ? 'Erase and continue' : 'Continue'

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-slate-100 p-4 text-slate-900">
      <div className="flex h-full max-h-[720px] w-full max-w-[1080px] overflow-hidden rounded-[20px] border border-slate-200 bg-white shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
        <aside className="hidden w-[260px] shrink-0 flex-col gap-[22px] bg-ws-night px-[22px] py-8 text-slate-200 md:flex">
          <div className="flex items-center gap-2.5 text-[15px] font-semibold">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-blue-600 font-bold text-white">W</span>Install WorkSuite OS
          </div>
          <ol aria-label="Install steps" className="m-0 flex list-none flex-col gap-1 p-0">
            {STEPS.map((s, i) => {
              const done = i < step, now = i === step
              return (
                <li key={s} aria-current={now ? 'step' : undefined} className={`flex h-10 items-center gap-3 rounded-[10px] px-2.5 ${now ? 'bg-slate-800' : ''}`}>
                  <span className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold ${done ? 'bg-green-900 text-green-300' : now ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
                    {done ? <CIcon name="check" size={12} /> : i + 1}
                  </span>
                  <span className={`text-sm ${now ? 'font-semibold text-slate-50' : done ? 'text-slate-300' : 'text-slate-400'}`}>{s}</span>
                </li>
              )
            })}
          </ol>
          <div className="mt-auto text-xs leading-relaxed text-slate-400">Version 1.0.3 · amd64<br />Installing offline from this USB drive</div>
        </aside>

        <section className="flex min-w-0 grow flex-col gap-[18px] overflow-auto px-11 py-9">
          <div className="flex flex-col gap-1.5">
            <div className="text-[13px] text-slate-600">Step {step + 1} of {STEPS.length}</div>
            <h1 className="m-0 text-[26px] font-[650] tracking-[-0.4px]">{[
              'Choose your language', 'Choose your keyboard layout', 'Where should WorkSuite OS go?', 'Encrypt the disk',
              'Create the administrator account', 'Installing WorkSuite OS', 'WorkSuite OS is installed'][step]}</h1>
            <p className="m-0 text-sm text-slate-600">{[
              'Used for the installer and as the system default.', 'You can add more layouts later in Settings.',
              'WorkSuite OS uses the whole disk. Dual boot is not supported in this version.',
              'LUKS2 full-disk encryption protects data if the device is lost. Unlocks with TPM and a passphrase.',
              'This local account can manage the device before it joins your organization.',
              'This takes a few minutes. Keep the device plugged in.', 'Remove the USB drive, then restart to start using WorkSuite OS.'][step]}</p>
          </div>

          {step === 0 && (
            <div role="radiogroup" aria-label="Language" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {LANGS.map((l) => (
                <label key={l} className={`flex items-center gap-3 rounded-xl px-4 py-3 ${lang === l ? 'border-2 border-blue-600 bg-blue-50' : 'border border-slate-200'}`}>
                  <input type="radio" name="lang" checked={lang === l} onChange={() => setLang(l)} className="h-[18px] w-[18px] accent-blue-600" />
                  <span className="text-[15px]">{l}</span>
                </label>
              ))}
            </div>
          )}

          {step === 1 && <>
            <label className={field}>Keyboard layout
              <select value={layout} onChange={(e) => setLayout(e.target.value)} className={input}>{LAYOUTS.map((l) => <option key={l}>{l}</option>)}</select>
            </label>
            <label className={field}>Type here to test your keyboard
              <input value={test} onChange={(e) => setTest(e.target.value)} className={input} />
            </label>
          </>}

          {step === 2 && <>
            <div role="radiogroup" aria-label="Target disk" className="flex flex-col gap-2">
              {DISKS.map((d) => {
                const sel = d.id === disk
                return (
                  <label key={d.id} className={`flex items-center gap-3.5 rounded-xl px-4 py-3.5 ${sel ? 'border-2 border-blue-600 bg-blue-50' : 'border border-slate-200 bg-white'} ${d.available ? '' : 'opacity-70'}`}>
                    <input type="radio" name="disk" checked={sel} disabled={!d.available} onChange={() => { setDisk(d.id); setConfirm('') }} className="m-0 h-[18px] w-[18px] accent-blue-600" />
                    <span className="flex grow flex-col gap-0.5"><span className="text-[15px] font-semibold">{d.name} · {d.size}</span><span className="text-[12.5px] text-slate-600">{d.path} · {d.note}</span></span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${d.available ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{d.available ? 'Will be erased' : 'Not available'}</span>
                  </label>
                )
              })}
            </div>
            <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 p-4">
              <input type="checkbox" checked={join} onChange={(e) => setJoin(e.target.checked)} className="mt-0.5 h-[18px] w-[18px] accent-blue-600" />
              <span className="flex flex-col gap-1"><span className="text-sm font-semibold">Join organization after install</span>
                <span className="text-[12.5px] leading-normal text-slate-600">Enroll with WorkSuite and join the directory (Active Directory, LDAP or OneAuth) so staff sign in with work accounts.</span></span>
            </label>
            {/* WSOS-INS-003: typed confirmation before erase */}
            <label className={field}>
              <span>To confirm, type the disk name: <span className="font-normal text-slate-600">{target.name}</span></span>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={confirm.length > 0 && !diskOk} className={input} />
            </label>
          </>}

          {step === 3 && <>
            <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 p-4">
              <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} className="mt-0.5 h-[18px] w-[18px] accent-blue-600" />
              <span className="flex flex-col gap-1"><span className="text-sm font-semibold">Encrypt the disk (LUKS2)</span>
                <span className="text-[12.5px] leading-normal text-slate-600">Recommended. Needed for full remote wipe.</span></span>
            </label>
            {encrypt ? <>
              <div className="flex flex-wrap gap-3">
                <label className={field}>Passphrase (8+ characters)<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} className={input} /></label>
                <label className={field}>Confirm passphrase<input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} aria-invalid={pass2.length > 0 && pass !== pass2} className={input} /></label>
              </div>
              <div className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-900"><CIcon name="key" />Recovery key — shown only once</div>
                {keyHidden ? <p className="m-0 text-[13px] text-amber-900">The recovery key was already shown and is no longer displayed.</p> : <>
                  <code className="select-all break-all rounded-lg bg-white px-3 py-2 font-mono text-[15px] tracking-wide">{recoveryKey}</code>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void navigator.clipboard?.writeText(recoveryKey).catch(() => {})} className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-[13px]">Copy</button>
                  </div>
                </>}
                <label className="flex items-center gap-2 text-[13px] text-amber-900">
                  <input type="checkbox" checked={keySaved} onChange={(e) => setKeySaved(e.target.checked)} className="h-4 w-4 accent-blue-600" />I have saved the recovery key somewhere safe
                </label>
              </div>
            </> : <p className="m-0 text-[13px] text-red-700">Without encryption, anyone with the disk can read its data and full remote wipe is unavailable.</p>}
          </>}

          {step === 4 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={field}>Full name<input value={acct.name} onChange={(e) => setAcct({ ...acct, name: e.target.value })} className={input} /></label>
              <label className={field}>Username (lowercase)<input value={acct.user} onChange={(e) => setAcct({ ...acct, user: e.target.value })} autoComplete="off" className={input} /></label>
              <label className={field}>Password (8+ characters)<input type="password" value={acct.pw} onChange={(e) => setAcct({ ...acct, pw: e.target.value })} className={input} /></label>
              <label className={field}>Confirm password<input type="password" value={acct.pw2} onChange={(e) => setAcct({ ...acct, pw2: e.target.value })} className={input} /></label>
              <label className={field}>Device name<input value={acct.host} onChange={(e) => setAcct({ ...acct, host: e.target.value })} className={input} /></label>
            </div>
          )}

          {step === 5 && (
            <div className="flex flex-col gap-3" aria-live="polite">
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Install progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
              </div>
              <div className="text-sm text-slate-700">{progress}% · {LOG[Math.min(LOG.length - 1, Math.floor(progress / (100 / LOG.length)))]}</div>
            </div>
          )}

          {step === 6 && (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <CIcon name="check" size={22} />Installed on {target.name}{encrypt ? ' with LUKS2 encryption' : ''}. {join ? 'You will be asked to join your organization after restart.' : ''}
            </div>
          )}

          <div className="mt-auto flex flex-wrap items-center gap-2.5">
            {step === 2 && <span className="text-[13px] text-red-700">All data on {target.name} will be permanently erased.</span>}
            {step > 0 && step < 5 && <button type="button" onClick={() => setStep((s) => s - 1)} className="ml-auto h-11 rounded-[10px] border border-slate-300 bg-white px-[18px] text-sm text-slate-700">Back</button>}
            {step < 5 && <button type="button" disabled={!canNext} onClick={next}
              className={`h-11 rounded-[10px] px-[22px] text-sm font-semibold text-white disabled:opacity-50 ${step === 0 ? 'ml-auto' : ''} ${step === 2 ? 'bg-red-700 hover:bg-red-800' : 'bg-blue-600 hover:bg-blue-700'}`}>{nextLabel}</button>}
            {step === 6 && <button type="button" onClick={onDone} className="ml-auto h-11 rounded-[10px] bg-blue-600 px-[22px] text-sm font-semibold text-white hover:bg-blue-700">Restart now</button>}
          </div>
        </section>
      </div>
    </div>
  )
}
