// The install graphic for setup's unattended steps, bound to real job states: during app installation the ring fills
// as apps settle (installed, already there, queued, skipped or failed) and each app's icon shows its own state; in
// the other steps the ring turns without a value. Under reduced motion (system setting or Settings › Accessibility)
// nothing moves: the ring and badges still show the same facts. Decorative except the ring's progress value.
import type { ReactNode } from 'react'
import { useReducedMotion } from '../AnimatedProgress'
import { Icon, Mark } from '../Ws'
import type { AppProgress } from '../../lib/setupApi'
import { WorkSuiteLoader } from '../WorkSuiteLoader'

const SETTLED = new Set<AppProgress['state']>(['installed', 'already', 'queued', 'skipped', 'failed'])
const R = 52
const C = 2 * Math.PI * R

/** Share of apps that have settled, 0–100; null when there is nothing to measure (indeterminate). */
export function settledPercent(apps: readonly AppProgress[]): number | null {
  const real = apps.filter((a) => a.state !== 'skipped')
  if (!real.length) return null
  return Math.round((real.filter((a) => SETTLED.has(a.state)).length / real.length) * 100)
}

export default function InstallGraphic({ apps, icon, label }: { apps: readonly AppProgress[]; icon: (a: AppProgress) => ReactNode; label: string }) {
  const reduced = useReducedMotion()
  const pct = settledPercent(apps)
  const shown = apps.filter((a) => a.state !== 'skipped')
  return (
    <div className="mb-2 flex flex-col items-center gap-5">
      <div className="relative flex size-[132px] items-center justify-center">
        <div aria-hidden className="absolute inset-2 rounded-full bg-[radial-gradient(circle,rgba(31,107,255,0.35),transparent_70%)] blur-md" />
        <svg viewBox="0 0 120 120" className="absolute inset-0 size-full -rotate-90"
          {...(pct === null ? { 'aria-hidden': true } : { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct })}>
          <defs><linearGradient id="ws-install-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1F6BFF" /><stop offset="1" stopColor="#18D4F0" /></linearGradient></defs>
          <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(127,178,255,0.15)" strokeWidth="7" />
          <circle cx="60" cy="60" r={R} fill="none" stroke="url(#ws-install-ring)" strokeWidth="7" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={pct === null ? C : C * (1 - pct / 100)}
            style={{ transition: reduced ? 'none' : 'stroke-dashoffset 0.6s ease-out' }} />
        </svg>
        <div className="relative flex flex-col items-center">
          {pct === null ? <WorkSuiteLoader size={48} decorative /> : <Mark size={40} />}
          {pct !== null && <span className="mt-1 text-[13px] font-semibold text-[#C9D6EE] tabular-nums">{pct}%</span>}
        </div>
      </div>
      {shown.length > 0 && (
        <ul aria-hidden className="m-0 flex list-none flex-wrap justify-center gap-3 p-0">
          {shown.map((a) => {
            const done = a.state === 'installed' || a.state === 'already'
            return (
              <li key={a.id} data-state={a.state}
                className={`relative rounded-2xl transition-[opacity,filter] duration-300 ${a.state === 'pending' ? 'opacity-40 grayscale' : ''} ${a.state === 'installing' && !reduced ? 'ws-install-active' : ''} ${done && !reduced ? 'ws-install-done' : ''}`}>
                {icon(a)}
                {a.state !== 'pending' && a.state !== 'installing' && (
                  <span className={`absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full border-2 border-[#0A1838] text-white ${done ? 'bg-[#2E9E6A]' : a.state === 'queued' ? 'bg-[#C98A1E]' : 'bg-[#D9452B]'}`}>
                    <Icon d={[done ? 'M5 12l5 5 9-10' : a.state === 'queued' ? 'M12 7v5l3 2' : 'M12 7v6M12 16.5v.5']} size={11} width={3} />
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
