// Renderer side of electron/desktopHost.ts: default apps (WSOS-DSK-009), clipboard history (WSOS-DSK-008) and the
// recovery launcher's problem report (WSOS-SES-005). Outside Electron (browser preview) there is no bridge, and the
// screens say the feature is unavailable rather than showing sample data.
export interface DefaultAppCategory { category: string; current: string | null; candidates: { id: string; name: string }[] }
export interface ClipEntry { id: number; text: string; at: number }
export interface ClipState { enabled: boolean; entries: ClipEntry[] }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface DesktopApi {
  defaultApps(): Promise<Result<DefaultAppCategory[]>>
  setDefaultApp(category: string, id: string): Promise<Result<true>>
  clipboardState(): Promise<ClipState>
  clipboardSetEnabled(on: boolean): Promise<ClipState>
  clipboardClear(): Promise<ClipState>
  clipboardRemove(id: number): Promise<ClipState>
  clipboardCopy(id: number): Promise<boolean>
  onClipboard(cb: (s: ClipState) => void): () => void
  problemReport(): Promise<Result<string>>
  /** G12: whether systemd restarted the shell since the user last saw the notice, and how many app scopes still run. */
  shellRestart?(): Promise<ShellRestart>
  shellRestartSeen?(restarts: number): Promise<boolean>
}
export interface ShellRestart { restarted: boolean; apps: number | null; restarts: number | null }

declare global {
  interface Window { worksuiteDesktop?: DesktopApi }
}

export const desktopApi: DesktopApi | null = (typeof window !== 'undefined' && window.worksuiteDesktop) || null

/** Categories in the order Settings lists them (electron/mimeapps.ts CATEGORIES). */
export const DEFAULT_APP_CATEGORIES = ['web', 'mail', 'pdf', 'image', 'text', 'video', 'audio', 'document', 'spreadsheet', 'presentation'] as const
