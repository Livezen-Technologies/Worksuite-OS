export type WindowApp = 'files' | 'appcenter' | 'settings'

export interface GreeterProps { onSignIn: (user: string) => void }
export interface LockProps { user: string; onUnlock: () => void }
export interface FirstRunProps { onDone: () => void }
export interface DesktopProps {
  user: string
  onLock: () => void
  onLogout: () => void
  onOpen: (app: WindowApp) => void
  children?: React.ReactNode // open shell windows (Files, App Center, Settings)
}
export interface WindowProps { onClose: () => void }
export interface RecoveryProps { onRestartShell: () => void; onLogout: () => void }
export interface InstallerProps { onDone: () => void }
