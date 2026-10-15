import { useCallback, useEffect, useState } from 'react'
import { nextState, type SessionEvent, type SessionState } from './lib/session'
import { os } from './lib/os'
import type { WindowApp } from './screens/types'
import Greeter from './screens/Greeter'
import Lock from './screens/Lock'
import FirstRun from './screens/FirstRun'
import Desktop from './screens/Desktop'
import Files from './screens/Files'
import AppCenter from './screens/AppCenter'
import Settings from './screens/Settings'
import Recovery from './screens/Recovery'
import Installer from './screens/Installer'

// `?mode=installer` boots the live-ISO installer; `?mode=recovery` the recovery launcher.
const mode = new URLSearchParams(location.search).get('mode')

export default function App() {
  const [state, setState] = useState<SessionState>(mode === 'recovery' ? 'recovery' : 'greeter')
  const [user, setUser] = useState('')
  const [firstRun, setFirstRun] = useState(() => localStorageGet('ws.firstRunDone') !== '1')
  const [win, setWin] = useState<WindowApp | null>(null)
  const [installing, setInstalling] = useState(mode === 'installer')
  const send = useCallback((e: SessionEvent) => setState((s) => nextState(s, e)), [])

  useEffect(() => {
    if (state === 'starting') send('shellReady')
    if (state === 'loggingOut') { setWin(null); send('loggedOut') }
  }, [state, send])

  // Super+L locks (WSOS-DSK-011); Escape closes the open window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state !== 'active') return
      if (e.metaKey && e.key.toLowerCase() === 'l') { e.preventDefault(); void os.lock(); send('lock') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, send])

  if (installing) return <Installer onDone={() => setInstalling(false)} />

  switch (state) {
    case 'greeter':
    case 'starting':
      return <Greeter onSignIn={(u) => { setUser(u); send('authSuccess') }} />
    case 'locked':
    case 'suspending':
      return <Lock user={user} onUnlock={() => send('unlock')} />
    case 'recovery':
      return <Recovery onRestartShell={() => send('shellRestarted')} onLogout={() => send('logout')} />
    case 'loggingOut':
      return null
    case 'active':
      if (firstRun) return <FirstRun onDone={() => { localStorageSet('ws.firstRunDone', '1'); setFirstRun(false) }} />
      return (
        <Desktop user={user} onLock={() => { void os.lock(); send('lock') }} onLogout={() => { void os.logout(); send('logout') }} onOpen={setWin}>
          {win === 'files' && <Files onClose={() => setWin(null)} />}
          {win === 'appcenter' && <AppCenter onClose={() => setWin(null)} />}
          {win === 'settings' && <Settings onClose={() => setWin(null)} />}
        </Desktop>
      )
  }
}

function localStorageGet(k: string) { try { return localStorage.getItem(k) } catch { return null } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
