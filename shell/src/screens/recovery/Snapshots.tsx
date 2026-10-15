// R4 Restore a snapshot. The list comes from the bridge; restoring needs a confirmation first.
import { useEffect, useState } from 'react'
import { os } from '../../lib/os'
import { defaultSnapshot, recoveryErrorText, snapshotDesc, snapshotWhen, type DoneInfo, type SnapshotInfo } from '../../lib/recovery'
import { Icon, mono } from '../../components/Ws'
import { Confirm, Footer, Header, MonoTag, Note, Page, RP, ghost, primary } from './Frame'

export default function Snapshots({ onBack, onDone }: { onBack: () => void; onDone: (d: DoneInfo) => void }) {
  const [list, setList] = useState<SnapshotInfo[] | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void os.recoverySnapshots().then((r) => {
      if (!alive) return
      if (r.ok) { setList(r.value); setPick(defaultSnapshot(r.value)) } else { setList([]); setUnavailable(r.error) }
    })
    return () => { alive = false }
  }, [])

  const chosen = list?.find((s) => s.id === pick) ?? null

  const restore = async () => {
    if (!chosen) return
    setBusy(true); setError(null)
    const r = await os.recoveryRestore(chosen.id)
    setBusy(false)
    if (!r.ok) { setConfirm(false); setError(recoveryErrorText(r.error)); return }
    onDone({ title: 'Snapshot restored', text: 'System files are back to the chosen point. Restart to finish.', ok: true, rows: [{ k: chosen.title, v: snapshotDesc(chosen), state: 'ok' }] })
    void os.power('restart')
  }

  return (
    <Page label="Restore a snapshot">
      <Header onBack={onBack} />
      <div className="flex flex-col gap-[22px] px-40 pb-28 pt-10 max-[900px]:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[30px] font-bold">Restore a snapshot</h1>
          <p className="m-0 text-[15px] text-[#8FA3C8]">System files go back to the chosen point. Documents, photos and other personal files are not touched.</p>
        </div>
        {list === null ? (
          <p role="status" className="m-0 text-sm text-[#8FA3C8]">Looking for snapshots…</p>
        ) : list.length === 0 ? (
          <div className="flex items-center gap-4 rounded-xl border border-[rgba(127,178,255,0.14)] bg-[rgba(14,32,72,0.5)] px-[18px] py-5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[rgba(127,178,255,0.1)]"><Icon d={[RP.snapshot]} size={22} stroke="#8FA3C8" /></span>
            <span className="flex flex-col gap-1">
              <span className="text-[15px] font-semibold">{unavailable ? 'Snapshots aren’t set up on this computer' : 'No snapshots yet'}</span>
              <span className="text-[13px] text-[#8FA3C8]">{unavailable ? 'This version of WorkSuite OS doesn’t take system snapshots yet, so there’s nothing to restore. Try startup repair or reinstalling instead.' : 'Snapshots are taken before updates and app installs. None have been taken on this computer.'}</span>
            </span>
          </div>
        ) : (
          <div role="radiogroup" aria-label="Snapshots" className="flex flex-col gap-2">
            {list.map((s) => {
              const on = s.id === pick
              return (
                <label key={s.id} className="flex cursor-pointer items-center gap-4 rounded-xl border px-[18px] py-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#7FB2FF]"
                  style={{ borderColor: on ? '#1F6BFF' : 'rgba(127,178,255,0.14)', background: on ? 'rgba(31,107,255,0.12)' : 'rgba(14,32,72,0.5)' }}>
                  <input type="radio" name="snap" checked={on} onChange={() => setPick(s.id)} className="h-[18px] w-[18px] accent-[#1F6BFF] outline-none" />
                  <span className="flex flex-1 flex-col gap-[3px]">
                    <span className="flex items-center gap-2 text-[15px] font-semibold">{s.title}{s.last_working && <MonoTag>LAST WORKING</MonoTag>}</span>
                    <span className="text-[13px] text-[#8FA3C8]">{snapshotDesc(s)}</span>
                  </span>
                  <span className={`${mono} text-xs text-[#8FA3C8]`}>v{s.os_version}</span>
                </label>
              )
            })}
          </div>
        )}
        {chosen && <Note>Apps installed after {snapshotWhen(chosen)} will need to be reinstalled. A snapshot of the current state is saved first, so you can undo this.</Note>}
        {error && <Note tone="warn" role="alert">{error}</Note>}
      </div>
      <Footer className="h-20 justify-end gap-3 px-40 max-[900px]:px-6">
        <button type="button" onClick={onBack} className={ghost}>Cancel</button>
        <button type="button" disabled={!chosen} onClick={() => setConfirm(true)} className={primary}>Restore and restart</button>
      </Footer>
      {confirm && chosen && (
        <Confirm title={`Restore “${chosen.title}”?`} busy={busy} onCancel={() => setConfirm(false)}
          actions={<button type="button" disabled={busy} onClick={() => void restore()} className={primary}>{busy ? 'Restoring…' : 'Restore and restart'}</button>}>
          <p className="m-0">System files go back to {snapshotDesc(chosen).replace(/ · .*$/, '')}. Apps installed after {snapshotWhen(chosen)} will need to be reinstalled.</p>
          <p className="m-0">Your documents, photos and other personal files are not touched. The computer restarts when it’s done.</p>
        </Confirm>
      )}
    </Page>
  )
}
