// R6 Complete.
import { useEffect, useRef, useState } from 'react'
import { os } from '../../lib/os'
import { recoveryErrorText, type DoneInfo } from '../../lib/recovery'
import { Icon } from '../../components/Ws'
import { Page, RP, ghost, link, primary } from './Frame'

export default function Done({ done, canSaveReport, onBack }: { done: DoneInfo; canSaveReport: boolean; onBack: () => void }) {
  const [saved, setSaved] = useState<string | null>(null)
  const h1 = useRef<HTMLHeadingElement>(null)
  useEffect(() => { h1.current?.focus() }, [])
  const allOk = done.ok

  return (
    <Page label="Recovery complete" center>
      <div className="flex min-h-full flex-col items-center justify-center gap-[18px] px-6 py-10">
        <div className="flex h-24 w-24 items-center justify-center rounded-full"
          style={{ background: allOk ? 'rgba(95,211,154,0.14)' : 'rgba(255,185,138,0.14)', boxShadow: `0 0 0 10px ${allOk ? 'rgba(95,211,154,0.06)' : 'rgba(255,185,138,0.06)'}` }}>
          {allOk ? <Icon d={[RP.check]} size={48} stroke="#5FD39A" width={2.5} /> : <Icon d={['M12 7v7', 'M12 17.5v.01']} size={48} stroke="#FFB98A" width={2.5} />}
        </div>
        <h1 ref={h1} tabIndex={-1} className="m-0 mt-3 text-[34px] font-bold tracking-[-0.02em] outline-none">{done.title}</h1>
        <p className="m-0 max-w-[520px] text-center text-base leading-normal text-[#8FA3C8]">{done.text}</p>
        {done.rows.length > 0 && (
          <ul className="m-0 mt-1.5 w-[520px] max-w-full list-none overflow-hidden rounded-[14px] border border-[rgba(127,178,255,0.16)] bg-[rgba(14,32,72,0.7)] p-0">
            {done.rows.map((r, i) => (
              <li key={r.k} className="flex items-center gap-3 px-[18px] py-3 text-sm" style={{ borderTop: i ? '1px solid rgba(127,178,255,0.1)' : 'none' }}>
                {r.state === 'ok' ? <Icon d={[RP.check]} size={16} stroke="#5FD39A" width={2.5} />
                  : r.state === 'problem' ? <Icon d={['M12 7v6', 'M12 16.5v.01']} size={16} stroke="#FF8A7A" width={2.5} />
                  : <Icon d={['M7 12h10']} size={16} stroke="#5E739C" width={2.5} />}
                <span className={`flex-1 ${r.state === 'skipped' ? 'text-[#8FA3C8]' : ''}`}>{r.k}<span className="sr-only">{r.state === 'ok' ? ': fine' : r.state === 'problem' ? ': needs attention' : ': not checked'}</span></span>
                <span className="text-xs text-[#8FA3C8]">{r.v}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3.5 flex gap-3">
          <button type="button" onClick={onBack} className={ghost}>Back to recovery menu</button>
          <button type="button" onClick={() => void os.power('restart')} className={`${primary} px-8`}>Restart</button>
        </div>
        {done.report && (canSaveReport
          ? <button type="button" onClick={async () => { const r = await os.recoverySaveReport(done.report ?? ''); setSaved(r.ok ? `Saved to ${r.value}` : recoveryErrorText(r.error)) }} className={link}>Save repair report to USB</button>
          : <span className="text-[13px] text-[#5E739C]">Saving the repair report to USB isn’t available in this version yet.</span>)}
        {saved && <p role="status" className="m-0 text-[13px] text-[#C9D6EE]">{saved}</p>}
      </div>
    </Page>
  )
}
