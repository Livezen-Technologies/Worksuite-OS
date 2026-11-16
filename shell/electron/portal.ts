import { BrowserWindow, Notification, session } from 'electron'
import { existsSync } from 'node:fs'
import { systemBridge } from './system'
import { CONNECTIVITY_CHECK_URL, initialPortalState, KILLSWITCH_MARKER, portalNavAllowed, portalStep, type PortalAction, type PortalState } from './connectivity'
import { APP_WINDOW } from './windowDefaults'

// ---------- captive portal (WSOS-INT-001) ----------
// NetworkManager's connectivity check (conf.d/20-worksuite-connectivity.conf) says `portal`: notify and open a
// "Sign in to network" window. That window is fully sandboxed in its own in-memory partition (no "persist:" prefix,
// so nothing is written to disk and nothing is shared with the shell or WorkSuite app sessions), has no preload and
// no Node, allows only http(s) navigation, denies permissions, pop-ups and downloads, and closes itself once
// connectivity is `full`. With the managed VPN kill switch loaded the portal is unreachable by design; the shell says
// so instead of opening a hole (docs/networking.md).
export function startPortalWatch(sys: ReturnType<typeof systemBridge>) {
  let state: PortalState = initialPortalState
  let portalWin: BrowserWindow | null = null
  const notify = (title: string, body: string, onClick?: () => void) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    if (onClick) n.on('click', onClick)
    n.show()
  }
  const apply = (actions: PortalAction[]) => {
    for (const a of actions) {
      if (a === 'notify_portal') notify('Sign in to network', 'This network needs you to sign in before you can use the internet.', () => dispatch('user_opened'))
      else if (a === 'notify_blocked_by_killswitch') notify('Network sign-in blocked', 'This network needs a sign-in page, but your organization\'s VPN kill switch blocks all traffic outside the VPN. Use another network or contact your IT team.')
      else if (a === 'notify_signed_in') notify('Connected', 'You are signed in to the network.')
      else if (a === 'open_window') openPortal()
      else if (a === 'close_window') { const w = portalWin; portalWin = null; w?.close() }
    }
  }
  const dispatch = (ev: Parameters<typeof portalStep>[1]) => { const r = portalStep(state, ev); state = r.state; apply(r.actions) }
  const openPortal = () => {
    if (portalWin) { portalWin.focus(); return }
    const partition = `ws-portal-${Date.now()}`   // ephemeral: in-memory, discarded with the window
    const ses = session.fromPartition(partition, { cache: false })
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (e) => e.preventDefault())
    const w = new BrowserWindow({
      ...APP_WINDOW, title: 'Sign in to network', width: 900, height: 700, backgroundColor: '#ffffff',
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, spellcheck: false },
    })
    const guard = (e: { preventDefault(): void }, url: string) => { if (!portalNavAllowed(url)) e.preventDefault() }
    w.webContents.on('will-navigate', guard)
    w.webContents.on('will-redirect', guard)
    w.webContents.on('will-attach-webview', (e) => e.preventDefault())
    // Pop-ups (some portals open terms in a new window) load in the same window instead, if allowed.
    w.webContents.setWindowOpenHandler(({ url }) => { if (portalNavAllowed(url)) void w.loadURL(url); return { action: 'deny' } })
    w.on('closed', () => { if (portalWin === w) { portalWin = null; dispatch('user_closed') } void ses.clearStorageData() })
    portalWin = w
    void w.loadURL(CONNECTIVITY_CHECK_URL)   // the portal intercepts the check URL and redirects to its sign-in page
  }
  const poll = async () => {
    const r = await sys.connectivity()
    if (r.available) dispatch({ connectivity: r.value, killSwitch: existsSync(KILLSWITCH_MARKER) })
  }
  void poll()
  setInterval(() => void poll(), 15_000).unref?.()
}
