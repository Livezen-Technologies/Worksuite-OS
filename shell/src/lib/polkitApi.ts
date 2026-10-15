// Renderer side of electron/polkit.ts (G05): the administrator prompt from the WorkSuite polkit agent. Outside
// Electron, or when the session runs the lxpolkit fallback, there is no bridge and the shell shows no prompt.
export interface PolkitPrompt {
  id: string
  actionId: string
  message: string
  program: string | null
  user: string
  userDisplay: string
  remaining: number | null
  locked: boolean
  lockedUntil: number | null
  deny: number
  unlockTime: number
  failed: boolean
  info: { text: string; error: boolean } | null
  busy: boolean
}

export interface PolkitApi {
  state(): Promise<PolkitPrompt | null>
  respond(id: string, password: string): Promise<boolean>
  cancel(id: string): Promise<boolean>
  onState(cb: (p: PolkitPrompt | null) => void): () => void
}

declare global {
  interface Window { worksuitePolkit?: PolkitApi }
}

export const polkitApi = (): PolkitApi | null => (typeof window !== 'undefined' && window.worksuitePolkit) || null

/** m:ss until the lockout ends (never negative). */
export function countdown(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
