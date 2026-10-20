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
  /** Shared notice state (see lib/useNotices); the desktop shows toasts and the notification center from it. */
  notes: ReturnType<typeof import('../lib/useNotices').useNotices>
}
export interface WindowProps { onClose: () => void }
export interface RecoveryProps { onRestartShell: () => void; onLogout: () => void }
export interface InstallerProps { onDone: () => void }
