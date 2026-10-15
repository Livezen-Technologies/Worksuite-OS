// R2 Unlock disk with recovery key. The key lives only in this component's state (gone when the screen closes,
// cleared after a successful unlock); it is never logged or stored and only leaves through recoveryUnlock.
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { os, type RecoveryInfo } from '../../lib/os'
import { KEY_GROUP_LEN, KEY_LENGTH, emptyKey, fillKeyGroups, formatGiB, formatKey, keyProblem, recoveryErrorText, type DoneInfo } from '../../lib/recovery'
import { Icon, mono } from '../../components/Ws'
import { Header, Page, ghost, link, primary, ring } from './Frame'

export default function Unlock({ info, onBack, onDone }: { info: RecoveryInfo | null; onBack: () => void; onDone: (d: DoneInfo) => void }) {
  const disk = info?.luks.find((d) => !d.unlocked) ?? null
  const [groups, setGroups] = useState(emptyKey)
  const [usePass, setUsePass] = useState(false)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const passRef = useRef<HTMLInputElement>(null)

  useEffect(() => { (usePass ? passRef.current : refs.current[0])?.focus() }, [usePass])

  const set = (i: number, text: string) => {
    const r = fillKeyGroups(groups, i, text)
    setGroups(r.groups); setError(null)
    if (r.focus !== i) refs.current[r.focus]?.focus()
  }
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => { e.preventDefault(); set(i, e.clipboardData.getData('text')) }
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !groups[i] && i > 0) { e.preventDefault(); refs.current[i - 1]?.focus() }
    if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0 && i > 0) refs.current[i - 1]?.focus()
    if (e.key === 'ArrowRight' && e.currentTarget.selectionStart === groups[i].length && i < groups.length - 1) refs.current[i + 1]?.focus()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!disk || busy) return
    const problem = usePass ? (pass ? null : 'Enter your disk passphrase.') : keyProblem(groups)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    const r = await os.recoveryUnlock(disk.device, usePass ? pass : formatKey(groups))
    setBusy(false)
    if (r.ok) {
      setGroups(emptyKey()); setPass('')
      onDone({ title: 'Your disk is unlocked', text: 'Your files can be read again. Run startup repair or restart to continue.', ok: true, rows: [{ k: 'Disk unlocked', v: disk.name, state: 'ok' }] })
      return
    }
    setError(recoveryErrorText(r.error))
    // Inputs are re-enabled on the next render; focus then.
    setTimeout(() => (usePass ? passRef.current : refs.current[0])?.focus(), 0)
  }

  const diskLine = disk && ['Disk: ' + disk.name, [disk.label, disk.version ? `(LUKS${disk.version})` : '(LUKS)'].filter(Boolean).join(' '), formatGiB(disk.size_bytes)].filter(Boolean).join(' · ')

  return (
    <Page label="Unlock disk">
      <Header onBack={onBack} />
      <form onSubmit={submit} noValidate className="flex flex-col items-center gap-[22px] px-6 pb-10 pt-[70px]">
        <div className="flex h-20 w-20 items-center justify-center rounded-[22px] bg-[rgba(31,107,255,0.18)]">
          <Icon size={38} stroke="#7FB2FF"><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></Icon>
        </div>
        <h1 className="m-0 text-[30px] font-bold">Unlock your disk</h1>
        <p id="unlock-desc" className="m-0 max-w-[520px] text-center text-[15px] leading-normal text-[#8FA3C8]">
          {usePass ? 'Enter the passphrase you chose for this disk during installation.' : `Enter the ${KEY_LENGTH}-character recovery key you saved during installation. Dashes are added for you.`}
        </p>
        {usePass ? (
          <input ref={passRef} type="password" aria-label="Disk passphrase" aria-describedby="unlock-desc" autoComplete="off" value={pass} disabled={busy || !disk}
            onChange={(e) => { setPass(e.target.value); setError(null) }} aria-invalid={!!error}
            className={`mt-2 h-12 w-[470px] max-w-full rounded-[10px] border border-[rgba(127,178,255,0.2)] bg-[rgba(4,10,26,0.6)] px-4 text-[17px] text-[#E8EEFA] focus:border-[#1F6BFF] ${ring}`} />
        ) : (
          <fieldset className="m-0 mt-2 border-0 p-0" aria-describedby="unlock-desc">
            <legend className="sr-only">Recovery key, {groups.length} groups of {KEY_GROUP_LEN}</legend>
            <div className="grid grid-cols-[repeat(4,110px)] gap-2.5">
              {groups.map((g, i) => (
                <input key={i} ref={(el) => { refs.current[i] = el }} aria-label={`Recovery key group ${i + 1}`} value={g} maxLength={KEY_GROUP_LEN}
                  inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} disabled={busy || !disk} aria-invalid={!!error}
                  onChange={(e) => set(i, e.target.value)} onPaste={(e) => onPaste(i, e)} onKeyDown={(e) => onKey(i, e)}
                  className={`${mono} h-12 rounded-[10px] border border-[rgba(127,178,255,0.2)] bg-[rgba(4,10,26,0.6)] text-center text-[17px] tracking-[0.08em] text-[#E8EEFA] focus:border-[#1F6BFF] disabled:opacity-60 ${ring}`} />
              ))}
            </div>
          </fieldset>
        )}
        <span className="text-[13px] text-[#8FA3C8]">{diskLine ?? 'No locked encrypted disk was found.'}</span>
        {error && <p role="alert" className="m-0 text-[13px] text-[#FFB4A8]">{error}</p>}
        <div className="mt-2.5 flex gap-3">
          <button type="button" onClick={() => { setUsePass((p) => !p); setError(null); setGroups(emptyKey()); setPass('') }} className={ghost}>
            {usePass ? 'Use recovery key instead' : 'Use passphrase instead'}
          </button>
          <button type="submit" disabled={busy || !disk} className={primary}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        </div>
        <button type="button" aria-expanded={help} aria-controls="key-help" onClick={() => setHelp((h) => !h)} className={`mt-1 ${link}`}>Where do I find my recovery key?</button>
        {help && (
          <p id="key-help" className="m-0 max-w-[520px] text-center text-[13px] leading-normal text-[#C9D6EE]">
            The installer showed it once, at the end of installation, as {KEY_LENGTH / KEY_GROUP_LEN} groups of {KEY_GROUP_LEN} letters and numbers. Look for where you saved or printed it. If this computer is managed by your organization, your IT team may have a copy.
          </p>
        )}
      </form>
    </Page>
  )
}
