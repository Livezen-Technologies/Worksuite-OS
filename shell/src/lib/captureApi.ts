// Renderer side of electron/capture.ts (screenshots, the snipping overlay and editor), electron/shortcutsHost.ts and
// the Windows-style Open targets (Super+V, Super+E…). Outside Electron (browser preview) it is null: the Snipping Tool
// and the shortcut settings say capture is unavailable, and the overlay can still be opened with a sample frame.
import type { ShortcutPrefs } from './shortcuts'

export type SnipMode = 'rect' | 'window' | 'full' | 'free'
export const SNIP_MODES: SnipMode[] = ['rect', 'window', 'full', 'free']
export const DELAYS = [0, 3, 5, 10]
export interface CaptureSettings { printOpensSnip: boolean; mode: SnipMode; delay: number }
export interface SnipOutput { name: string; x: number; y: number; width: number; height: number }
export interface SnipOpen { id: number; mode: SnipMode; outputs: SnipOutput[] }
/** kind: saved (Print: in Pictures/Screenshots and copied), copied (a snip), failed, blocked (policy). */
export interface Captured { id: number; kind: 'saved' | 'copied' | 'failed' | 'blocked'; file: string | null; copied?: boolean }
/** what: files, settings, monitor, a11y, clipboard, emoji, shortcuts, snip; previous: the app window that had the focus. */
export interface ShellOpen { what: string; previous: string; backdrop: string | null }
type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface CaptureApi {
  allowed(): Promise<boolean>
  settings(): Promise<CaptureSettings>
  setSettings(p: Partial<CaptureSettings>): Promise<CaptureSettings>
  capture(kind: 'print' | 'save' | 'window' | 'snip'): Promise<boolean>
  snipStart(mode: SnipMode, delay: number): Promise<boolean>
  snipFrame(id: number, output: string): Promise<string | null>
  snipDone(id: number, dataUrl: string): Promise<{ id: number } | null>
  snipCancel(id: number): Promise<void>
  snipImage(id: number): Promise<{ id: number; url: string; file: string | null } | null>
  snipCopy(dataUrl: string): Promise<boolean>
  snipSave(dataUrl: string): Promise<Result<string>>
  snipReveal(file: string): Promise<{ root: string; rel: string; name: string } | null>
  shortcutsApply(p: ShortcutPrefs | undefined): Promise<{ available: true; value: true } | { available: false; reason: string }>
  edit(cmd: 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo'): Promise<boolean>
  onSnipOpen(cb: (o: SnipOpen) => void): () => void
  onSnipClose(cb: (o: { id: number }) => void): () => void
  onCaptured(cb: (c: Captured) => void): () => void
  onShellOpen(cb: (o: ShellOpen) => void): () => void
  onToastClicked(cb: (key: string) => void): () => void
}

declare global {
  interface Window { worksuiteCapture?: CaptureApi }
}

export const captureApi: CaptureApi | null = (typeof window !== 'undefined' && window.worksuiteCapture) || null

/** Ask the shell (main window) to open the snipping overlay locally, e.g. in the browser preview with a sample frame. */
export const SNIP_LOCAL_EVENT = 'ws:snip-local'
/** Open a shell surface from inside the shell (Super+V pressed while the shell has the focus…). */
export const SHELL_OPEN_EVENT = 'ws:shell-open'
export function openShell(what: string) { window.dispatchEvent(new CustomEvent<ShellOpen>(SHELL_OPEN_EVENT, { detail: { what, previous: '', backdrop: null } })) }
/** Open the Snipping Tool's editor on a kept screenshot (detail: its id; 0 = the home screen). */
export const SNIP_EDIT_EVENT = 'ws:snip-edit'
/** A snip started from the Snipping Tool opens back in it instead of showing the toast. */
export const snipState = { fromApp: false }
