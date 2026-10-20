export type WindowApp = 'files' | 'appcenter' | 'settings' | 'monitor' | 'snip'

export interface GreeterProps { onSignIn: (user: string) => void }
export interface LockProps { user: string; name?: string; onUnlock: () => void
  /** How many of the newest notices are unread (useNotices); defaults to all of them. */
  unread?: number
  notices?: { id: string; title: string; at: number; tone: 'ok' | 'warn' | 'error'; app?: string }[] }
export interface FirstRunProps { onDone: () => void; userName?: string }
export interface DesktopProps {
  user: string
  /** The account's full name, when it has one. */
  fullName?: string
  onLock: () => void
  onLogout: () => void
  onOpen: (app: WindowApp) => void
  children?: React.ReactNode // open shell windows (Files, App Center, Settings)
  /** The open shell windows for the taskbar (App.tsx, lib/shellWindows.ts); without it any child counts as showing. */
  shellWindows?: { app: WindowApp; title: string; icon: string; minimized: boolean; active: boolean }[]
  /** A shell window's taskbar button: 'toggle' minimizes the active one and restores or raises the others; 'focus'
   *  only raises (the shell was behind an app, so the person wants to see it). */
  onShellWindow?: (app: WindowApp, how: 'toggle' | 'focus') => void
  /** Shared notice state (see lib/useNotices); the desktop shows toasts and the notification center from it. */
  notes: ReturnType<typeof import('../lib/useNotices').useNotices>
}
export interface WindowProps {
  onClose: () => void
  /** False while another shell window is in front or this one is minimized (its window-wide keys stay off). */
  active?: boolean
}
export interface RecoveryProps { onRestartShell: () => void; onLogout: () => void }
export interface InstallerProps { onDone: () => void }
