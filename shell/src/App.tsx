import { useCallback, useEffect, useState } from 'react'
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
  const [win, setWin] = useState<WindowApp | null>(null)
  // An archive opened from elsewhere (Files is the default handler for archive types): open it in Files.
  const [archive, setArchive] = useState<{ root: string; rel: string; n: number } | null>(null)
  useEffect(() => os.onOpenArchive((at) => { setArchive({ ...at, n: Date.now() }); setWin('files') }), [])
  const [installing, setInstalling] = useState(mode === 'installer')
  const inSession = (state === 'active' && !firstRun) || state === 'locked' || state === 'suspending'
  const notes = useNotices(inSession)
  const send = useCallback((e: SessionEvent) => setState((s) => nextState(s, e)), [])

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
        <Desktop user={user} onLock={() => { void requestLock(() => os.lock(), () => send('lock')) }} onLogout={() => { void os.logout(); send('logout') }} onOpen={setWin} notes={notes}>
          {win === 'files' && <Files archive={archive} onClose={() => { setWin(null); setArchive(null) }} />}
          {win === 'appcenter' && <AppCenter onClose={() => setWin(null)} />}
          {win === 'settings' && <Settings onClose={() => setWin(null)} />}
          {win === 'monitor' && <Monitor onClose={() => setWin(null)} />}
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
