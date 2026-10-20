import { useCallback, useEffect, useMemo, useState } from 'react'
import { nextState, requestLock, type SessionEvent, type SessionState } from './lib/session'
import { os } from './lib/os'
import type { WindowApp } from './screens/types'
import Greeter from './screens/Greeter'
import Lock from './screens/Lock'
import FirstRun from './screens/FirstRun'
import Desktop from './screens/Desktop'
import Files from './screens/Files'
import AppCenter from './screens/AppCenter'
import Monitor from './screens/Monitor'
import Settings from './screens/Settings'
import Recovery from './screens/Recovery'
import Installer from './screens/Installer'
import { useNotices } from './lib/useNotices'
import { useT } from './i18n'
import SafeLauncher from './screens/SafeLauncher'
import SnippingTool, { OPEN_FILES_EVENT } from './screens/SnippingTool'
import TextContextMenu from './components/TextContextMenu'
import { captureApi, SNIP_EDIT_EVENT, snipState, type SnipMode } from './lib/captureApi'
import { ShellWindowsHost, SHELL_APP_ICON, type ShellWindowActions, type ShellWindowContent } from './components/ShellWindow'
import { activeWin, closeWin, focusWin, minimizeWin, openWin, setRect, taskbarClick, toggleMaxWin, type ShellWins } from './lib/shellWindows'
import { t } from './i18n'

// `?mode=installer` boots the live-ISO installer; `?mode=recovery` the recovery launcher.
const mode = new URLSearchParams(location.search).get('mode')

export default function App() {
  // Re-render every screen when the language changes (screens read strings through t()).
  useT()
  // In the installed session greetd/PAM has already signed the person in, so the shell opens straight on the
  // desktop: its own sign-in board cannot authenticate (ws:authenticate always refuses) and would strand the
  // session. The sign-in board stays for the browser preview, which has no Electron bridge.
  const [state, setState] = useState<SessionState>(mode === 'recovery' ? 'recovery' : window.worksuite ? 'starting' : 'greeter')
  const [user, setUser] = useState('')
  // The account's full name from /etc/passwd (GECOS), shown on the lock screen and the first-run greeting.
  const [realName, setRealName] = useState('')
  const [firstRun, setFirstRun] = useState(() => localStorageGet('ws.firstRunDone') !== '1')
  // The shell's own windows, bottom to top (lib/shellWindows.ts): several can be open, moved, resized, minimized.
  const [wins, setWins] = useState<ShellWins>([])
  const setWin = useCallback((app: WindowApp | null) => setWins((w) => (app ? openWin(w, app) : [])), [])
  const closeApp = useCallback((app: WindowApp) => setWins((w) => closeWin(w, app)), [])
  // An archive opened from elsewhere (Files is the default handler for archive types): open it in Files.
  const [archive, setArchive] = useState<{ root: string; rel: string; n: number } | null>(null)
  useEffect(() => os.onOpenArchive((at) => { setArchive({ ...at, n: Date.now() }); setWin('files') }), [])
  // Files at a folder (the Snipping Tool's "Show in Files"), and the Snipping Tool on a kept screenshot.
  const [folder, setFolder] = useState<{ root: string; rel: string; n: number } | null>(null)
  const [shotId, setShotId] = useState(0)
  useEffect(() => {
    const files = (e: Event) => { const d = (e as CustomEvent<{ root: string; rel: string }>).detail; setFolder({ ...d, n: Date.now() }); setWin('files') }
    const edit = (e: Event) => setShotId(Number((e as CustomEvent<number>).detail) || 0)
    window.addEventListener(OPEN_FILES_EVENT, files)
    window.addEventListener(SNIP_EDIT_EVENT, edit)
    return () => { window.removeEventListener(OPEN_FILES_EVENT, files); window.removeEventListener(SNIP_EDIT_EVENT, edit) }
  }, [])
  // New in the Snipping Tool: the window closes (the shell goes below the apps) and the snip opens back in it.
  const newSnip = (mode: SnipMode, delay: number) => { snipState.fromApp = true; closeApp('snip'); void captureApi?.snipStart(mode, delay) }
  const [installing, setInstalling] = useState(mode === 'installer')
  const inSession = (state === 'active' && !firstRun) || state === 'locked' || state === 'suspending'
  const notes = useNotices(inSession)
  const send = useCallback((e: SessionEvent) => setState((s) => nextState(s, e)), [])
  const actions = useMemo<ShellWindowActions>(() => ({
    focus: (app) => setWins((w) => focusWin(w, app)),
    close: (app) => {
      setWins((w) => closeWin(w, app))
      if (app === 'files') { setArchive(null); setFolder(null) }
      if (app === 'snip') setShotId(0)
    },
    minimize: (app) => setWins((w) => minimizeWin(w, app)),
    toggleMax: (app) => setWins((w) => toggleMaxWin(w, app)),
    move: (app, r) => setWins((w) => setRect(w, app, r)),
  }), [])
  const active = activeWin(wins)
  const content = (app: WindowApp): ShellWindowContent => {
    const close = () => actions.close(app)
    const on = active === app
    switch (app) {
      case 'files': return { title: t('files.title'), icon: SHELL_APP_ICON.files, closeLabel: t('files.close'), body: <Files archive={archive} folder={folder} active={on} onClose={close} /> }
      case 'appcenter': return { title: t('launcher.appCenter'), icon: SHELL_APP_ICON.appcenter, body: <AppCenter active={on} onClose={close} /> }
      case 'settings': return { title: t('launcher.settings'), icon: SHELL_APP_ICON.settings, closeLabel: t('settings.close'), body: <Settings active={on} onClose={close} /> }
      case 'monitor': return { title: t('monitor.title'), icon: SHELL_APP_ICON.monitor, body: <Monitor active={on} onClose={close} /> }
      case 'snip': return { title: t('snip.app'), icon: SHELL_APP_ICON.snip, body: <SnippingTool shotId={shotId} active={on} onNew={newSnip} onClose={close} /> }
    }
  }
  const taskbarWins = wins.map((w) => ({ app: w.app, title: content(w.app).title, icon: SHELL_APP_ICON[w.app], minimized: w.minimized, active: active === w.app }))

  // The lock screen and first-run greeting name the real session user (the login name), never a placeholder, also
  // when the session started without the shell's own sign-in.
  useEffect(() => {
    let live = true
    os.sysUsers().then((r) => {
      if (!live || !r.available || !r.value.current) return
      setUser((u) => u || r.value.current)
      const me = r.value.users.find((u) => u.login === r.value.current)
      if (me && me.name && me.name !== me.login) setRealName(me.name)
    }).catch(() => {})
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (state === 'starting') send('shellReady')
    if (state === 'loggingOut') { setWin(null); send('loggedOut') }
  }, [state, send])

  // Super+L locks (WSOS-DSK-011); Escape closes the open window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state !== 'active') return
      if (e.metaKey && e.key.toLowerCase() === 'l') { e.preventDefault(); void requestLock(() => os.lock(), () => send('lock')) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, send])

  if (installing) return <Installer onDone={() => setInstalling(false)} />
  // Minimal launcher after repeated shell crashes (WSOS-SES-005).
  if (mode === 'safe') return <SafeLauncher />

  switch (state) {
    case 'starting':
      return null
    case 'greeter':
      return <Greeter onSignIn={(u) => { setUser(u); send('authSuccess') }} />
    case 'locked':
    case 'suspending':
      return <Lock user={user} name={realName || undefined} notices={notes.notices} onUnlock={() => send('unlock')} />
    case 'recovery':
      return <Recovery onRestartShell={() => send('shellRestarted')} onLogout={() => send('logout')} />
    case 'loggingOut':
      return null
    case 'active':
      if (firstRun) return <FirstRun userName={realName || displayName(user)} onDone={() => { localStorageSet('ws.firstRunDone', '1'); setFirstRun(false) }} />
      return (
        <Desktop user={user} fullName={realName || undefined} onLock={() => { void requestLock(() => os.lock(), () => send('lock')) }} onLogout={() => { void os.logout(); if (!(window as { worksuite?: unknown }).worksuite) send('logout') /* Electron: the session ends; never the preview greeter */ }} onOpen={setWin} notes={notes}
          shellWindows={taskbarWins} onShellWindow={(app, how) => setWins((w) => (how === 'focus' ? focusWin(w, app) : taskbarClick(w, app)))}>
          {wins.length > 0 && <ShellWindowsHost wins={wins} content={content} actions={actions} />}
        </Desktop>
      )
  }
}

function localStorageGet(k: string) { try { return localStorage.getItem(k) } catch { return null } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
// Login names arrive as user, user@domain or DOMAIN\user; show the bare name capitalised.
function displayName(login: string) {
  const bare = login.split('\\').pop()!.split('@')[0]
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}
