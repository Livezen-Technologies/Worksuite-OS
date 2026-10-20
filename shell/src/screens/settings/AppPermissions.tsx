// Settings › Privacy & security › App permissions (issue #21): what each sandboxed app may use (camera, microphone,
// location, notifications, screenshots, running in the background) as the XDG permission store records it, with
// Allow/Deny, Forget (ask again next time) and Reset app; who uses the camera or microphone right now; recent
// decisions; and, plainly, how each kind of access is enforced. Organization deny rules show as locked. The prompts
// themselves are the portal's own dialogs, which an app cannot draw or answer for itself.
import { useCallback, useEffect, useState } from 'react'
import { Svg, btnGhost, card, chip, linkBtn, rowLine, Switch } from '../../components/Dk'
import { appPermsApi, byApp, type Enforcement, type Grant, type InUse, type PermEvent, type StoreResource } from '../../lib/appPermsApi'
import { formatDate, t, type MessageKey } from '../../i18n'
import { Note } from './ui'

const RES_KEY: Record<StoreResource, MessageKey> = {
  camera: 'perm.res.camera', microphone: 'perm.res.microphone', location: 'perm.res.location',
  notifications: 'perm.res.notifications', screenshot: 'perm.res.screenshot', background: 'perm.res.background',
}
const ENF_ORDER = ['camera', 'microphone', 'location', 'notifications', 'screen_recording', 'remote_control', 'files', 'clipboard', 'usb', 'bluetooth', 'system_settings', 'admin'] as const

type State = { grants: Grant[]; inUse: InUse; enforcement: Record<string, Enforcement> }

export function AppPermissionsSection() {
  const api = appPermsApi()
  const [s, setS] = useState<State | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [recent, setRecent] = useState<PermEvent[]>([])
  const load = useCallback(async () => {
    if (!api) return
    const r = await api.state().catch(() => ({ ok: false as const, error: 'failed' }))
    if (r.ok) { setS(r.value); setErr(null) } else setErr(r.error)
    setRecent(await api.recent().catch(() => []))
  }, [api])
  useEffect(() => { void load() }, [load])
  if (!api) return null
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p.catch(() => ({ ok: false, error: 'failed' }))
    if (!r.ok) setErr(r.error ?? 'failed')
    await load()
  }
  const apps = s ? byApp(s.grants) : []
  const using = s ? [...s.inUse.camera.map((a) => [a, 'camera'] as const), ...s.inUse.microphone.map((a) => [a, 'microphone'] as const)] : []
  return (
    <section aria-labelledby="perm-h" className="flex flex-col gap-2">
      <h2 id="perm-h" className="m-0 text-sm font-semibold">{t('perm.title')}</h2>
      <Note>{t('perm.intro')}</Note>
      {err && <p role="alert" className="m-0 text-xs text-[#FF8A7A]">{err === 'blocked_by_policy' ? t('perm.blocked') : err === 'flatpak_missing' ? t('perm.noStore') : t('perm.failed')}</p>}
      {using.length > 0 && (
        <div role="status" className="rounded-xl border border-[rgba(255,159,90,0.35)] bg-[rgba(255,159,90,0.12)] px-4 py-2.5 text-[13px]">
          {using.map(([a, r]) => <div key={a + r}>{t(r === 'camera' ? 'perm.usingCamera' : 'perm.usingMic', { app: a })}</div>)}
        </div>
      )}
      <div className={`${card} overflow-hidden`}>
        {s && apps.length === 0 && <div className="px-4 py-3 text-[13px] text-[#8FA3C8]">{t('perm.none')}</div>}
        {apps.map(({ app, grants }) => (
          <div key={app} className={`flex flex-col gap-1.5 px-4 py-3 ${rowLine}`}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{app}</span>
              <button type="button" className={linkBtn} onClick={() => void act(api.reset(app))}>{t('perm.reset')}</button>
            </div>
            {grants.map((g) => (
              <div key={g.resource} className="flex items-center gap-3 pl-2 text-[13px]">
                <span className="flex-1">{t(RES_KEY[g.resource])}</span>
                {g.locked && <span className={chip}>{t('perm.locked')}</span>}
                <button type="button" className={linkBtn} disabled={g.locked} onClick={() => void act(api.revoke(g.resource, app))}>{t('perm.forget')}</button>
                <Switch small label={`${t(RES_KEY[g.resource])} · ${app}`} checked={g.allowed} disabled={g.locked} onChange={(v) => void act(api.set(g.resource, app, v))} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <details className={`${card} px-4 py-3 text-[13px]`}>
        <summary className="cursor-pointer font-medium">{t('perm.howTitle')}</summary>
        <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
          {s && ENF_ORDER.map((k) => {
            const e = s.enforcement[k]
            if (!e) return null
            return (
              <li key={k} className="flex gap-3">
                <span className="w-[150px] shrink-0 text-[#C9D6EE]">{t(`perm.kind.${k}` as MessageKey)}</span>
                <span className="text-[#8FA3C8]">{t(`perm.mech.${e.mechanism}` as MessageKey)}{e.scope === 'sandboxed' ? ` ${t('perm.sandboxedOnly')}` : ''}</span>
              </li>
            )
          })}
        </ul>
      </details>
      {recent.length > 0 && (
        <details className={`${card} px-4 py-3 text-[13px]`}>
          <summary className="cursor-pointer font-medium">{t('perm.recent')}</summary>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-xs text-[#C9D6EE]">
            {recent.map((e, i) => (
              <li key={i}>{formatDate(e.at)} · <span className="font-mono">{e.app}</span> · {e.resource === '*' ? t('perm.all') : isRes(e.resource) ? t(RES_KEY[e.resource]) : e.resource} · {t(`perm.act.${e.action}` as MessageKey)}{e.by === 'app_request' ? ` (${t('perm.byPrompt')})` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      <div><button type="button" className={`${btnGhost} gap-2`} onClick={() => void load()}><Svg d="M4 4v6h6M20 20v-6h-6M5 15a7 7 0 0 0 12 3M19 9A7 7 0 0 0 7 6" size={14} />{t('perm.refresh')}</button></div>
    </section>
  )
}
const isRes = (r: string): r is StoreResource => r in RES_KEY

/** Taskbar indicator while any app has the camera or microphone open (issue #21). */
export function MediaInUseBadge({ pollMs = 3000 }: { pollMs?: number }) {
  const api = appPermsApi()
  const [u, setU] = useState<InUse>({ camera: [], microphone: [] })
  useEffect(() => {
    if (!api) return
    let live = true
    const tick = () => { void api.inUse().then((x) => { if (live) setU(x) }).catch(() => {}) }
    tick()
    const id = setInterval(tick, pollMs)
    return () => { live = false; clearInterval(id) }
  }, [api, pollMs])
  if (!api || (u.camera.length === 0 && u.microphone.length === 0)) return null
  const who = [...new Set([...u.camera, ...u.microphone])].join(', ')
  const label = u.camera.length && u.microphone.length ? t('perm.badgeBoth') : u.camera.length ? t('perm.badgeCamera') : t('perm.badgeMic')
  return (
    <span role="status" title={t('perm.badgeHint', { apps: who })} className="flex items-center gap-1.5 rounded-full bg-[#B7791F] px-2.5 py-1 text-xs font-semibold text-white">
      <span aria-hidden="true" className="size-2 rounded-full bg-white" />{label}<span className="sr-only">{t('perm.badgeHint', { apps: who })}</span>
    </span>
  )
}
