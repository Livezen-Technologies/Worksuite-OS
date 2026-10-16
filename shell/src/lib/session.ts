// Session lifecycle states and transitions, SRS §4.3.
export type SessionState = 'greeter' | 'starting' | 'active' | 'locked' | 'suspending' | 'recovery' | 'loggingOut'

export type SessionEvent =
  | 'authSuccess' | 'shellReady' | 'shellFailedThrice' | 'lock' | 'unlock'
  | 'suspend' | 'resume' | 'logout' | 'loggedOut' | 'shellRestarted' | 'compositorCrash'

const transitions: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  greeter: { authSuccess: 'starting' },
  starting: { shellReady: 'active', shellFailedThrice: 'recovery' },
  active: { lock: 'locked', suspend: 'suspending', logout: 'loggingOut', shellFailedThrice: 'recovery', compositorCrash: 'greeter' },
  locked: { unlock: 'active', suspend: 'suspending', compositorCrash: 'greeter' },
  // WSOS-LOCK-002: resume always lands on the lock screen.
  suspending: { resume: 'locked' },
  recovery: { shellRestarted: 'active', logout: 'loggingOut', compositorCrash: 'greeter' },
  loggingOut: { loggedOut: 'greeter' },
}

export function nextState(state: SessionState, event: SessionEvent): SessionState {
  return transitions[state][event] ?? state
}

// WSOS-SES-005: three shell crashes within 60 s start the recovery launcher.
export function shouldEnterRecovery(crashTimes: number[], now: number, windowMs = 60_000, limit = 3): boolean {
  return crashTimes.filter((t) => now - t <= windowMs).length >= limit
}

// One lock screen (WSOS-LOCK-001): on a real session the system locker (gtklock over ext-session-lock) takes the
// screen and unlocks it itself, so the shell must not put its own lock board up behind it. The shell's board is only
// for sessions without a system locker (the browser preview, or when `loginctl lock-session` failed).
export async function requestLock(lock: () => Promise<boolean | void>, showShellLock: () => void): Promise<void> {
  let system = false
  try { system = (await lock()) === true } catch { system = false }
  if (!system) showShellLock()
}
