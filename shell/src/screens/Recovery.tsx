import { useState } from 'react'
import type { RecoveryProps } from './types'
import CIcon from '../components/CIcon'
import { os } from '../lib/os'

const APPS = [
  { id: 'files', name: 'Files', mark: 'F', cls: 'bg-sky-100 text-sky-700' },
  { id: 'settings', name: 'Settings', mark: 'S', cls: 'bg-slate-700 text-white' },
  { id: 'firefox', name: 'Firefox', mark: 'Fx', cls: 'bg-slate-100 text-slate-700' },
  { id: 'office', name: 'WorkSuite Office', mark: 'O', cls: 'bg-orange-100 text-orange-700' },
  { id: 'terminal', name: 'Terminal', mark: '>_', cls: 'bg-slate-950 text-slate-200' },
]

const BUNDLE = [
  { id: 'journal', name: 'Shell journal (last 30 min)', size: '412 KB', note: 'worksuite-shell and GPU process logs' },
  { id: 'crash', name: 'Crash reports (3)', size: '1.8 MB', note: 'Minidumps from 10:09, 10:10, 10:10' },
  { id: 'pkgs', name: 'Installed package versions', size: '36 KB', note: 'dpkg list and WorkSuite channel' },
  { id: 'hw', name: 'Hardware summary', size: '8 KB', note: 'GPU, driver and display configuration' },
  { id: 'policy', name: 'Applied policy snapshot', size: '12 KB', note: 'No passwords or tokens included' },
]

export default function Recovery({ onRestartShell, onLogout }: RecoveryProps) {
  const [report, setReport] = useState<'closed' | 'review' | 'sending' | 'sent'>('closed')
  const [include, setInclude] = useState<Record<string, boolean>>(() => Object.fromEntries(BUNDLE.map((b) => [b.id, true])))
  const [notice, setNotice] = useState('')

  const tile = 'flex flex-col gap-1.5 rounded-[14px] p-5 text-left text-slate-50 transition-colors'
  const selected = BUNDLE.filter((b) => include[b.id])

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-ws-night p-6 text-slate-200">
      <div className="flex w-full max-w-[880px] flex-col gap-6">
        <div role="alert" className="flex items-start gap-4 rounded-[14px] border border-amber-700 bg-slate-800 px-6 py-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-amber-500/15 text-amber-400"><CIcon name="warn" size={22} /></span>
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-[650] text-slate-50">The WorkSuite desktop stopped 3 times</h1>
            <p className="m-0 text-sm leading-normal text-slate-300">You're in recovery mode. Your open apps are still running and your files and unsynced changes are safe. Try restarting the desktop, or use the tools below.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button type="button" onClick={onRestartShell} className={`${tile} border-2 border-blue-500 bg-blue-600/15 hover:bg-blue-600/25`}>
            <span className="text-base font-semibold">Restart WorkSuite desktop</span>
            <span className="text-[13px] text-slate-300">Starts the shell again without closing your apps.</span>
          </button>
          <button type="button" onClick={() => setNotice('Rollback needs an administrator. Ask your IT team to approve rolling back to 1.0.2.')} className={`${tile} border border-slate-700 bg-[#111a2c] hover:bg-slate-800`}>
            <span className="text-base font-semibold">Roll back last WorkSuite update</span>
            <span className="text-[13px] text-slate-300">Return the shell from 1.0.3 to 1.0.2. Needs an administrator.</span>
          </button>
          <button type="button" onClick={() => setNotice('Package repair started. This is logged for your IT team.')} className={`${tile} border border-slate-700 bg-[#111a2c] hover:bg-slate-800`}>
            <span className="text-base font-semibold">Repair packages</span>
            <span className="text-[13px] text-slate-300">Finish an interrupted install or update. Logged for your IT team.</span>
          </button>
          <button type="button" aria-expanded={report !== 'closed'} onClick={() => setReport('review')} className={`${tile} border border-slate-700 bg-[#111a2c] hover:bg-slate-800`}>
            <span className="text-base font-semibold">Report a problem</span>
            <span className="text-[13px] text-slate-300">Review the diagnostic bundle, then send it to support.</span>
          </button>
        </div>

        {notice && <p role="status" className="m-0 rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-[13px] text-slate-300">{notice}</p>}

        {report !== 'closed' && (
          <section aria-label="Diagnostic bundle" className="flex flex-col gap-3 rounded-[14px] border border-slate-700 bg-[#111a2c] p-5">
            <div className="flex items-center gap-2">
              <h2 className="m-0 text-base font-semibold text-slate-50">Review diagnostic bundle</h2>
              <button type="button" aria-label="Close report" onClick={() => setReport('closed')} className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800"><CIcon name="close" size={16} /></button>
            </div>
            {report === 'sent' ? (
              <p role="status" className="m-0 flex items-center gap-2 text-sm text-emerald-300"><CIcon name="check" />Sent to support. Reference WS-RPT-20261015-0142.</p>
            ) : <>
              <p className="m-0 text-[13px] text-slate-400">Choose what to include. Nothing is uploaded until you select Send.</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {BUNDLE.map((b) => (
                  <li key={b.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-800">
                      <input type="checkbox" checked={include[b.id]} disabled={report === 'sending'} onChange={(e) => setInclude((s) => ({ ...s, [b.id]: e.target.checked }))} className="h-4 w-4 accent-blue-500" />
                      <CIcon name="file" size={16} className="text-slate-400" />
                      <span className="flex grow flex-col"><span className="text-sm text-slate-100">{b.name}</span><span className="text-xs text-slate-400">{b.note}</span></span>
                      <span className="text-xs text-slate-400">{b.size}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">{selected.length} of {BUNDLE.length} items selected</span>
                <button type="button" disabled={selected.length === 0 || report === 'sending'}
                  onClick={() => { setReport('sending'); setTimeout(() => setReport('sent'), 1200) }}
                  className="ml-auto h-10 rounded-lg bg-blue-600 px-4 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  {report === 'sending' ? 'Sending…' : 'Send to support'}
                </button>
              </div>
            </>}
          </section>
        )}

        <div className="flex flex-col gap-2.5">
          <div className="text-xs font-bold uppercase tracking-[0.06em] text-slate-400">Keep working</div>
          <div className="flex flex-wrap gap-2.5">
            {APPS.map((a) => (
              <button key={a.id} type="button" onClick={() => void os.launchApp(a.id)} className="flex h-12 items-center gap-2.5 rounded-[10px] border border-slate-700 bg-[#111a2c] px-4 text-sm text-slate-200 hover:bg-slate-800">
                <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-md text-[11px] font-bold ${a.cls}`}>{a.mark}</span>{a.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-2 text-[13px] text-slate-400">
          <span>Error: worksuite-shell exited (GPU process crashed) · 10:09, 10:10, 10:10</span>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onLogout} className="h-10 rounded-lg border border-slate-700 px-3.5 text-[13px] text-slate-200 hover:bg-slate-800">Log out</button>
            <button type="button" onClick={() => void os.power('restart')} className="h-10 rounded-lg border border-slate-700 px-3.5 text-[13px] text-slate-200 hover:bg-slate-800">Restart computer</button>
          </div>
        </div>
      </div>
    </div>
  )
}
