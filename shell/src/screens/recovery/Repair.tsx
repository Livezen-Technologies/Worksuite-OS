// R3 Startup repair. Each row is a real check through the bridge; interrupted package changes are repaired by
// the package service (polkit-authorized job). Progress is the share of checks finished.
import { useEffect, useRef, useState } from 'react'
import { os, packageErrorText, type PackageJobEvent } from '../../lib/os'
import { initialChecks, repairPercent, repairSummary, type CheckId, type CheckRow, type CheckState, type DoneInfo } from '../../lib/recovery'
import { Footer, Header, Page, link, small } from './Frame'

/** Start a package job and wait for its JobFinished event (events that arrive before the job id are kept). */
async function runJob(start: () => Promise<{ ok: true; value: string } | { ok: false; error: string }>): Promise<{ ok: boolean; error?: string }> {
  const seen: PackageJobEvent[] = []
  let want: string | null = null
  let done: ((e: PackageJobEvent) => void) | null = null
  const off = os.onPkgJob((e) => { if (e.kind !== 'finished') return; if (want && e.job === want) done?.(e); else seen.push(e) })
  try {
    const r = await start()
    if (!r.ok) return { ok: false, error: r.error }
    want = r.value
    const early = seen.find((e) => e.job === want)
    const fin = early ?? await new Promise<PackageJobEvent>((res) => { done = res })
    return fin.result === 'success' ? { ok: true } : { ok: false, error: fin.error ?? 'failed' }
  } finally { off() }
}

function StateIcon({ s }: { s: CheckState }) {
  if (s === 'ok') return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#5FD39A" /><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#061029" strokeWidth="2.4" strokeLinecap="round" /></svg>
  if (s === 'fixed' || s === 'problem') return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill={s === 'fixed' ? '#FFB98A' : '#FF8A7A'} /><path d="M12 7v6M12 16.5h.01" stroke="#061029" strokeWidth="2.4" strokeLinecap="round" /></svg>
  if (s === 'active') return <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#18D4F0" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9" /></svg>
  if (s === 'unavailable') return <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-[rgba(127,178,255,0.3)] text-[11px] leading-none text-[#8FA3C8]">–</span>
  return <span aria-hidden="true" className="box-border h-5 w-5 rounded-full border-2 border-[rgba(127,178,255,0.3)]" />
}

const STATE_TEXT: Record<CheckState, string> = { wait: 'Waiting', active: 'Checking', ok: 'Fine', fixed: 'Repaired', problem: 'Problem', unavailable: 'Not checked' }

export default function Repair({ onBack, onDone }: { onBack: () => void; onDone: (d: DoneInfo) => void }) {
  const [rows, setRows] = useState<CheckRow[]>(initialChecks)
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [stopped, setStopped] = useState(false)
  const stop = useRef(false)
  const pct = repairPercent(rows)

  useEffect(() => {
    let alive = true
    const update = (id: CheckId, state: CheckState, note: string) => {
      if (!alive) return
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, state, note } : r)))
    }
    const say = (line: string) => { if (alive) setLog((l) => [...l, `${new Date().toLocaleTimeString('en-GB')}  ${line}`]) }
    void (async () => {
      const final: CheckRow[] = initialChecks()
      for (const row of final) {
        if (stop.current || !alive) return
        update(row.id, 'active', 'Checking…')
        let r = await os.recoveryCheck(row.id).catch(() => ({ status: 'unavailable' as const, note: 'Couldn’t run this check' }))
        say(`${row.label}: ${r.note}`)
        if (r.status === 'problem' && r.fixable && row.id === 'packages' && !stop.current) {
          update(row.id, 'active', 'Finishing interrupted package changes…')
          say('Repairing packages (dpkg --configure -a, apt-get -f install)')
          const j = await runJob(() => os.pkgRepair())
          r = j.ok ? { status: 'fixed', note: 'Finished interrupted changes' } : { status: 'problem', note: packageErrorText(j.error ?? 'failed') }
          say(`${row.label}: ${r.note}`)
        }
        row.state = r.status; row.note = r.note
        update(row.id, r.status, r.note)
      }
      if (!alive || stop.current) return
      const s = repairSummary(final)
      onDone({ title: s.title, text: s.text, ok: s.problems === 0, report: final.map((r) => `${r.label}: ${STATE_TEXT[r.state]} — ${r.note}`).join('\n'),
        rows: final.map((r) => ({ k: r.label, v: r.note, state: r.state === 'ok' || r.state === 'fixed' ? 'ok' : r.state === 'problem' ? 'problem' : 'skipped' })) })
    })()
    return () => { alive = false }
  }, [onDone])

  return (
    <Page label="Startup repair">
      <Header right={<span className="text-[13px] text-[#8FA3C8]">Startup repair</span>} />
      <div className="flex flex-col gap-6 px-40 pb-28 pt-12 max-[900px]:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[30px] font-bold">{stopped ? 'Startup repair stopped' : 'Checking your system'}</h1>
          <p className="m-0 text-[15px] text-[#8FA3C8]">{stopped ? 'Checks that hadn’t run yet were skipped.' : 'This can take a few minutes. Your files won\'t be changed.'}</p>
        </div>
        <div role="progressbar" aria-label="Startup repair progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}% of checks finished`}
          className="h-2 overflow-hidden rounded bg-[rgba(127,178,255,0.12)]">
          <div className="h-full rounded bg-[linear-gradient(90deg,#1F6BFF,#18D4F0)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-live="polite">
          {rows.map((c) => {
            const active = c.state === 'active'
            return (
              <li key={c.id} className="flex items-center gap-3.5 rounded-[10px] border px-4 py-[13px]"
                style={{ background: active ? 'rgba(24,212,240,0.08)' : 'rgba(14,32,72,0.45)', borderColor: active ? 'rgba(24,212,240,0.3)' : 'rgba(127,178,255,0.08)' }}>
                <StateIcon s={c.state} />
                <span className="flex-1 text-[15px]" style={{ color: c.state === 'wait' || c.state === 'unavailable' ? '#8FA3C8' : '#E8EEFA' }}>
                  {c.label}<span className="sr-only">: {STATE_TEXT[c.state]}</span>
                </span>
                <span className="text-[13px]" style={{ color: c.state === 'fixed' ? '#FFB98A' : c.state === 'problem' ? '#FF8A7A' : '#8FA3C8' }}>{c.note}</span>
              </li>
            )
          })}
        </ol>
        {showLog && (
          <pre id="repair-log" aria-label="Repair log" tabIndex={0} className="m-0 max-h-36 overflow-auto rounded-[10px] border border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.6)] p-3 font-['IBM_Plex_Mono',ui-monospace,monospace] text-xs leading-relaxed text-[#C9D6EE]">
            {log.length ? log.join('\n') : 'No entries yet.'}
          </pre>
        )}
      </div>
      <Footer className="h-[72px] justify-between px-40 max-[900px]:px-6">
        <button type="button" aria-expanded={showLog} aria-controls="repair-log" onClick={() => setShowLog((v) => !v)} className={`${link} text-sm no-underline`}>{showLog ? 'Hide log' : 'Show log'}</button>
        {stopped
          ? <button type="button" onClick={onBack} className={`${small} rounded-[10px] px-5 py-[11px] text-sm font-medium`}>Back to recovery menu</button>
          : <button type="button" onClick={() => { stop.current = true; setStopped(true) }} className={`${small} rounded-[10px] px-5 py-[11px] text-sm font-medium`}>Stop</button>}
      </Footer>
    </Page>
  )
}
