// Typed renderer API. In Electron the preload exposes `window.worksuite` with named functions only
// (WSOS-SEC-001, §10.3); in a plain browser (dev/design review) a local stub answers instead.
export interface WorkSuiteApi {
  authenticate(user: string, password: string): Promise<{ ok: boolean; message?: string }>
  lock(): Promise<void>
  logout(): Promise<void>
  power(action: 'suspend' | 'restart' | 'shutdown'): Promise<void>
  launchApp(appId: string): Promise<void>
  openLink(url: string): Promise<void>
  // WorkSuite cloud identity through the credentials broker (SRS §8.1). Tokens never reach the renderer.
  cloudSignIn(serverUrl: string): Promise<CloudResult<CloudAccount>>
  cloudSignOut(accountId: string): Promise<CloudResult<true>>
  cloudAccounts(): Promise<CloudResult<CloudAccount[]>>
}

export interface CloudAccount { id: string; name: string | null; server_url: string; state?: string }
export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string }

declare global {
  interface Window { worksuite?: WorkSuiteApi }
}

const stub: WorkSuiteApi = {
  async authenticate(_user, password) {
    return password.length > 0 ? { ok: true } : { ok: false, message: 'Enter your password.' }
  },
  async lock() {},
  async logout() {},
  async power() {},
  async launchApp() {},
  async openLink() {},
  async cloudSignIn(serverUrl) {
    stubAccounts = [{ id: 'preview:u-1', name: 'Hasarinda', server_url: serverUrl, state: 'signed_in' }]
    return { ok: true, value: stubAccounts[0] }
  },
  async cloudSignOut(id) { stubAccounts = stubAccounts.filter((a) => a.id !== id); return { ok: true, value: true } },
  async cloudAccounts() { return { ok: true, value: stubAccounts } },
}

let stubAccounts: CloudAccount[] = []

/** Broker error codes → text for the user. */
export function cloudErrorText(code: string): string {
  switch (code) {
    case 'discovery_failed': return 'That server didn’t answer as a WorkSuite server. Check the address.'
    case 'insecure_url': return 'The server must use https.'
    case 'sign_in_timeout': return 'Sign-in wasn’t finished in the browser. Try again.'
    case 'access_denied': return 'Sign-in was cancelled.'
    case 'broker_unavailable': return 'The sign-in service isn’t running. Try again in a moment.'
    default: return 'Sign-in didn’t work. Check your connection and try again.'
  }
}

/** "work.example.com" → "https://work.example.com"; personal mode uses WorkSuite Cloud. */
export function serverUrlFor(mode: 'personal' | 'enterprise', server: string): string {
  if (mode === 'personal') return 'https://worksuitecloud.com'
  const s = server.trim()
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`
}

export const os: WorkSuiteApi = (typeof window !== 'undefined' && window.worksuite) || stub
