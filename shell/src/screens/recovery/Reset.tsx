// R5 Reinstall WorkSuite OS. "Keep my files" is the default; erasing needs the disk name typed in the confirmation.
import { useState } from 'react'
import { os, type RecoveryInfo } from '../../lib/os'
import { recoveryErrorText, type DoneInfo } from '../../lib/recovery'
import { Icon } from '../../components/Ws'
import { Confirm, Footer, Header, Note, Page, RP, danger, ghost, primary, ring, small } from './Frame'

type Mode = 'keep' | 'erase'

export default function Reset({ info, onBack, onDone }: { info: RecoveryInfo | null; onBack: () => void; onDone: (d: DoneInfo) => void }) {
  const [mode, setMode] = useState<Mode>('keep')
  const [confirm, setConfirm] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usbNote, setUsbNote] = useState<string | null>(null)
  const disk = info?.disk ?? 'this computer'
  const available = !!info?.features.reinstall
  const erase = mode === 'erase'

  const run = async () => {
    setBusy(true); setError(null)
    const r = await os.recoveryReinstall(mode)
    setBusy(false); setConfirm(false); setTyped('')
    if (!r.ok) { setError(recoveryErrorText(r.error)); return }
    onDone(erase
      ? { title: 'Ready to reinstall', text: 'WorkSuite OS will erase the disk and reinstall when you restart, then start first-time setup.', ok: true, rows: [{ k: 'Erase everything', v: disk, state: 'ok' }] }
      : { title: 'Ready to reinstall', text: 'WorkSuite OS will reinstall its system files when you restart. Your account, documents and settings stay.', ok: true, rows: [{ k: 'Keep my files', v: disk, state: 'ok' }] })
  }

  const card = (m: Mode) => {
    const on = mode === m
    return `flex cursor-pointer flex-col gap-3.5 rounded-[14px] border p-5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#7FB2FF] ${on ? (m === 'erase' ? 'border-[#D9452B] bg-[rgba(217,69,43,0.1)]' : 'border-[#1F6BFF] bg-[rgba(31,107,255,0.12)]') : (m === 'erase' ? 'border-[rgba(255,138,122,0.35)] bg-[rgba(14,32,72,0.5)]' : 'border-[rgba(127,178,255,0.14)] bg-[rgba(14,32,72,0.5)]')}`
  }

  return (
    <Page label="Reinstall WorkSuite OS">
      <Header onBack={onBack} />
      <div className="flex flex-col gap-[22px] px-40 pb-28 pt-10 max-[900px]:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[30px] font-bold">Reinstall WorkSuite OS</h1>
          <p className="m-0 text-[15px] text-[#8FA3C8]">Installs fresh system files from the recovery partition. No internet needed.</p>
        </div>
        <div role="radiogroup" aria-label="Reinstall options" className="grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1">
          <label className={card('keep')}>
            <span className="flex items-center gap-3"><input type="radio" name="mode" checked={mode === 'keep'} onChange={() => setMode('keep')} className="h-[18px] w-[18px] accent-[#1F6BFF] outline-none" /><span className="text-[17px] font-semibold">Keep my files</span></span>
            <ul className="m-0 flex flex-col gap-1.5 pl-[30px] text-[13px] text-[#C9D6EE]">
              <li>Your account, documents and settings stay</li>
              <li>Apps from the App Center reinstall automatically</li>
              <li>Takes about 15 minutes</li>
            </ul>
          </label>
          <label className={card('erase')}>
            <span className="flex items-center gap-3"><input type="radio" name="mode" checked={mode === 'erase'} onChange={() => setMode('erase')} className="h-[18px] w-[18px] accent-[#D9452B] outline-none" /><span className="text-[17px] font-semibold">Erase everything</span></span>
            <ul className="m-0 flex flex-col gap-1.5 pl-[30px] text-[13px] text-[#C9D6EE]">
              <li className="text-[#FFB4A8]">Deletes all accounts and files on {disk}</li>
              <li>Back to the first-time setup</li>
              <li>Use before selling or giving away</li>
            </ul>
          </label>
        </div>
        <div className="flex items-center gap-3.5 rounded-xl border border-[rgba(127,178,255,0.12)] bg-[rgba(14,32,72,0.5)] px-[18px] py-4">
          <Icon d={[RP.usb]} size={22} stroke="#7FB2FF" />
          <span className="flex flex-1 flex-col gap-0.5 text-sm">
            Back up first? Copy your files to a USB drive before reinstalling.
            {usbNote && <span role="status" className="text-xs text-[#8FA3C8]">{usbNote}</span>}
          </span>
          <button type="button" disabled={!info?.features.copy_usb} aria-describedby={!info?.features.copy_usb ? 'usb-off' : undefined}
            onClick={async () => { const r = await os.recoveryCopyToUsb(); setUsbNote(r.ok ? 'Copying started.' : recoveryErrorText(r.error)) }} className={`${small} font-medium`}>Copy files to USB</button>
        </div>
        {!info?.features.copy_usb && <span id="usb-off" className="-mt-4 text-xs text-[#8FA3C8]">Copying to USB isn’t available in this version yet.</span>}
        {error && <Note tone="warn" role="alert">{error}</Note>}
      </div>
      <Footer className="h-20 justify-end gap-3 px-40 max-[900px]:px-6">
        {!available && <span id="reinstall-off" className="mr-auto text-[13px] text-[#8FA3C8]">Reinstalling isn’t available in this version of WorkSuite OS.</span>}
        <button type="button" onClick={onBack} className={ghost}>Cancel</button>
        <button type="button" disabled={!available} aria-describedby={!available ? 'reinstall-off' : undefined} onClick={() => setConfirm(true)} className={erase ? danger : primary}>
          {erase ? 'Erase and reinstall' : 'Reinstall and keep files'}
        </button>
      </Footer>
      {confirm && (
        <Confirm title={erase ? 'Erase everything and reinstall?' : 'Reinstall WorkSuite OS?'} busy={busy} onCancel={() => { setConfirm(false); setTyped('') }}
          actions={<button type="button" disabled={busy || (erase && typed.trim() !== disk)} onClick={() => void run()} className={erase ? danger : primary}>
            {busy ? 'Starting…' : erase ? 'Erase and reinstall' : 'Reinstall and keep files'}</button>}>
          {erase ? <>
            <p className="m-0 text-[#FFB4A8]">All accounts, documents, photos and settings on {disk} will be deleted. This can’t be undone.</p>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[#C9D6EE]">
              <span>Type <span className="font-['IBM_Plex_Mono',monospace] text-[#E8EEFA]">{disk}</span> to confirm</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy}
                className={`h-11 rounded-[10px] border border-[rgba(127,178,255,0.2)] bg-[rgba(4,10,26,0.6)] px-3.5 font-['IBM_Plex_Mono',monospace] text-[15px] text-[#E8EEFA] focus:border-[#D9452B] ${ring}`} />
            </label>
          </> : <>
            <p className="m-0">Fresh system files are installed from the recovery partition. Your account, documents and settings stay.</p>
            <p className="m-0">It takes about 15 minutes. Keep the computer plugged in.</p>
          </>}
        </Confirm>
      )}
    </Page>
  )
}
