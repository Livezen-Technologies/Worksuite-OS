// Renderer side of electron/desktopHost.ts: default apps (WSOS-DSK-009), clipboard history (WSOS-DSK-008) and the
// recovery launcher's problem report (WSOS-SES-005). Outside Electron (browser preview) there is no bridge, and the
// screens say the feature is unavailable rather than showing sample data.
export interface DefaultAppCategory { category: string; current: string | null; candidates: { id: string; name: string }[] }
/** One clipboard history item (electron/clipboard.ts): text, an image (image: a preview data: URL) or files. */
export interface ClipEntry { id: number; kind?: 'text' | 'image' | 'files'; text: string; at: number; pinned?: boolean; image?: string; files?: string[]; mime?: string; size?: number }
/** blocked: turned off by policy; persist: pinned items are kept across sign-ins (encrypted, needs the keyring). */
export interface ClipState { enabled: boolean; entries: ClipEntry[]; blocked?: boolean; persist?: boolean }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface DesktopApi {
  defaultApps(): Promise<Result<DefaultAppCategory[]>>
  setDefaultApp(category: string, id: string): Promise<Result<true>>
  clipboardState(): Promise<ClipState>
  clipboardSetEnabled(on: boolean): Promise<ClipState>
  /** all: pinned items too (Settings' "Clear clipboard data" keeps them, like Windows, unless asked). */
  clipboardClear(all?: boolean): Promise<ClipState>
  clipboardRemove(id: number): Promise<ClipState>
  clipboardCopy(id: number): Promise<boolean>
  clipboardPin?(id: number, on: boolean): Promise<ClipState>
  /** Puts the item on the clipboard, focuses `previous` again and presses Ctrl+V in it. */
  clipboardPaste?(id: number, previous: string): Promise<boolean>
  /** Types an emoji or symbol into `previous` (the clipboard is left alone). */
  clipboardType?(text: string, previous: string): Promise<boolean>
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
