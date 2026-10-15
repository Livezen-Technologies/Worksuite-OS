// OS update view logic on top of the package service's coordinator status (WSOS-AUP-011). Pure functions;
// the screens in screens/Updates.tsx render what these return.
import type { OsUpdateStatus, PackageJobEvent } from './os'

/** Phases the package service reports for an ApplyUpdate job (services/package-service/src/service.ts). */
export const UPDATE_PHASES: Record<string, string> = {
  refreshing: 'Refreshing package lists', downloading: 'Downloading', applying: 'Applying system files',
  flatpak: 'Updating apps', checking: 'Checking the system', done: 'Finishing up',
}
export interface JobProgress { percent: number; phase: string }
export function updateJobProgress(e: PackageJobEvent): JobProgress | null {
  return e.kind === 'progress' && e.phase && e.phase in UPDATE_PHASES ? { percent: Math.max(0, Math.min(100, e.percent ?? 0)), phase: e.phase } : null
}

/** Numeric-aware version compare (same rules as the package service's compareVersions). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.split(/(~|\d+|[^\d~]+)/).filter(Boolean)
  const pa = split(a), pb = split(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    if (x === y) continue
    if (x === '~') return -1
    if (y === '~') return 1
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? 1 : -1
    return x < y ? -1 : 1
  }
  return 0
}

export const WAIT_REASON: Record<string, string> = {
  waiting_for_user: 'Ready to install when you are.',
  outside_window: 'Installs in the maintenance window.',
  not_idle: 'Installs next time the computer is idle.',
  metered: 'Waiting for a non-metered connection.',
  deferred: 'You postponed this update.',
  paused: 'Your organization paused this release.',
  pulled: 'This release was withdrawn.',
  not_in_rollout: 'Rolling out gradually; this computer isn’t included yet.',
  manual_mode: 'Updates are set to manual.',
  not_entitled: 'This release needs a WorkSuite edition your organization’s licence doesn’t include. Security updates still install.',
  download_interrupted: 'The download was interrupted. It continues where it stopped on the next try.',
}

export const fmtWhen = (ms: number | null | string) => (ms == null ? '—' : new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))

export type Tone = 'download' | 'busy' | 'ready' | 'ok' | 'warn'
export type Action = 'check' | 'later' | 'install' | 'schedule' | 'restart'
export interface HeroView { tone: Tone; title: string; sub: string; progress: JobProgress | 'indeterminate' | null; secondary: Action | null; primary: Action | null }

const offerOpen = (s: OsUpdateStatus) => (s.state === 'waiting' || s.state === 'available') && s.reason !== 'paused' && s.reason !== 'pulled'
/** Badge on Settings › Updates and the taskbar: something for the person to do. */
export const needsAttention = (s: OsUpdateStatus | null) => !!s && (offerOpen(s) || s.state === 'ready_to_restart' || s.state === 'restart_pending')
export const canDefer = (s: OsUpdateStatus) => s.deferrals_left !== 0

export function heroView(s: OsUpdateStatus, job: JobProgress | null, now = Date.now()): HeroView {
  const v = s.version ?? ''
  const due = s.deadline ? ` · required by ${fmtWhen(s.deadline)}` : ''
  const left = s.deferrals_left != null ? ` · ${s.deferrals_left} postponement${s.deferrals_left === 1 ? '' : 's'} left` : ''
  switch (s.state) {
    case 'up_to_date': return { tone: 'ok', title: 'WorkSuite OS is up to date', sub: `Version ${s.installed} · last checked ${fmtWhen(s.last_check)}`, progress: null, secondary: null, primary: 'check' }
    case 'checking': return { tone: 'busy', title: 'Checking for updates…', sub: 'Contacting the update server', progress: 'indeterminate', secondary: null, primary: null }
    case 'available':
    case 'waiting': {
      const open = offerOpen(s)
      return { tone: 'download', title: `WorkSuite OS ${v} is available`, sub: `${s.mandatory ? 'Required by your organization · ' : ''}${WAIT_REASON[s.reason ?? ''] ?? ''}${due}${left}`,
        progress: null, secondary: open && canDefer(s) ? 'later' : null, primary: open ? 'install' : 'check' }
    }
    case 'installing': {
      const downloading = !job || job.phase === 'refreshing' || job.phase === 'downloading'
      return { tone: 'busy', title: `${downloading ? 'Downloading' : 'Installing'} WorkSuite OS ${v}`, sub: 'You can keep working. We’ll let you know when it’s ready.', progress: job ?? 'indeterminate', secondary: null, primary: null }
    }
    case 'ready_to_restart': return { tone: 'ready', title: 'Restart to finish updating', sub: `WorkSuite OS ${s.installed} is installed and verified · restart to start using it`, progress: null, secondary: 'schedule', primary: 'restart' }
    case 'restart_pending': {
      const mins = s.restart_at ? Math.max(0, Math.ceil((s.restart_at - now) / 60_000)) : 0
      return { tone: 'warn', title: `Restarting in ${mins} min to install WorkSuite OS ${v}`, sub: 'This update is required by your organization. Save your work.', progress: null, secondary: null, primary: 'restart' }
    }
    case 'failed': return { tone: 'warn', title: 'The last update check or install didn’t work', sub: s.reason ? s.reason.charAt(0).toUpperCase() + s.reason.slice(1) + '.' : '', progress: null, secondary: null, primary: 'check' }
  }
}

/**
 * What the shell learns from watching status changes: an install that started from a forced restart
 * (restart_pending → installing, shown full screen) and an install that failed while we watched.
 */
export interface Failure { installed: string; version: string | null; reason: string; phase: string | null; percent: number | null }
export interface Tracking { last: OsUpdateStatus['state'] | null; forced: boolean; failure: Failure | null }
export const START: Tracking = { last: null, forced: false, failure: null }

export function track(t: Tracking, s: OsUpdateStatus, job: JobProgress | null): Tracking {
  let { forced, failure } = t
  if (s.state === 'installing' && t.last === 'restart_pending') forced = true
  if (s.state !== 'installing' && s.state !== 'ready_to_restart') forced = false
  if (s.state === 'failed' && t.last === 'installing') failure = { installed: s.installed, version: s.version, reason: s.reason ?? 'update failed', phase: job?.phase ?? null, percent: job?.percent ?? null }
  return { last: s.state, forced, failure }
}

/** U6: show "What's new" once after the installed version goes up. */
export function whatsNew(seen: string | null, installed: string): boolean {
  return !!seen && compareVersions(installed, seen) > 0
}

/** Restart dialog (U4): only what the coordinator and shell can really do. */
export type RestartChoice = 'now' | 'scheduled' | 'next_boot' | 'remind'
export interface RestartOption { id: RestartChoice; label: string; desc: string; cta: string; disabled: boolean }
export function restartOptions(): RestartOption[] {
  return [
    { id: 'now', label: 'Restart now', desc: 'Save your work first · open apps will close', cta: 'Restart now', disabled: false },
    { id: 'scheduled', label: 'At a set time', desc: 'Not available yet: the update service can’t schedule a restart', cta: 'Schedule', disabled: true },
    { id: 'next_boot', label: 'Next time I restart or shut down', desc: 'The update is already installed and finishes on the next start', cta: 'OK', disabled: false },
    { id: 'remind', label: 'Remind me tomorrow', desc: 'Hides this reminder for 24 hours', cta: 'Remind me', disabled: false },
  ]
}
export const REMIND_KEY = 'ws.updRemindAt'
export const SEEN_KEY = 'ws.osSeen'
