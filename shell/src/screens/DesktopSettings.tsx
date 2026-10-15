// Settings › Default apps (WSOS-DSK-009) and the clipboard history section of Privacy & security (WSOS-DSK-008).
// Values come from electron/desktopHost.ts (XDG mimeapps.list, wl-clipboard); without the bridge the sections say
// they are unavailable.
import { useEffect, useState } from 'react'
import { DEFAULT_APP_CATEGORIES, desktopApi, type ClipState, type DefaultAppCategory } from '../lib/desktopApi'
import { Switch, btnGhost, card, linkBtn, rowLine } from '../components/Dk'
import { formatDate, t, type MessageKey } from '../i18n'

const select = 'box-border min-w-[220px] rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 py-[9px] text-[13px] text-[#E8EEFA]'

export function DefaultAppsPanel() {
  const [cats, setCats] = useState<DefaultAppCategory[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = () => {
    if (!desktopApi) { setErr(t('defapps.unavailable')); return }
    void desktopApi.defaultApps().then((r) => (r.ok ? setCats(r.value) : setErr(t('defapps.unavailable')))).catch(() => setErr(t('defapps.unavailable')))
  }
  useEffect(load, [])
  const choose = async (category: string, id: string) => {
    const r = await desktopApi?.setDefaultApp(category, id)
    if (r && !r.ok) setErr(t('defapps.saveFailed'))
    else { setErr(null); load() }
  }
  const order = (c: DefaultAppCategory) => DEFAULT_APP_CATEGORIES.indexOf(c.category as (typeof DEFAULT_APP_CATEGORIES)[number])
  return <>
    <div className="flex items-center justify-between gap-4"><h1 className="m-0 text-[28px] font-bold">{t('settings.nav.Default apps')}</h1></div>
    <p className="m-0 text-[13px] text-[#8FA3C8]">{t('defapps.hint')}</p>
    {err && <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{err}</p>}
    {cats && (
      <div className={`${card} flex flex-col px-5`}>
        {[...cats].sort((a, b) => order(a) - order(b)).map((c) => {
          const label = t(`defapps.cat.${c.category}` as MessageKey)
          return (
            <div key={c.category} className={`flex items-center justify-between gap-4 py-3.5 ${rowLine}`}>
              <span className="text-sm">{label}</span>
              {c.candidates.length ? (
                <select aria-label={label} className={select} value={c.current ?? ''} onChange={(e) => void choose(c.category, e.target.value)}>
                  {!c.current && <option value="">{t('defapps.none')}</option>}
                  {c.candidates.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              ) : <span className="text-[13px] text-[#8FA3C8]">{t('defapps.noApps')}</span>}
            </div>
          )
        })}
      </div>
    )}
  </>
}

export function ClipboardSection() {
  const [s, setS] = useState<ClipState | null>(null)
  useEffect(() => {
    if (!desktopApi) return
    void desktopApi.clipboardState().then(setS).catch(() => {})
    return desktopApi.onClipboard(setS)
  }, [])
  if (!desktopApi) return null
  return (
    <section aria-label={t('clip.title')} className={`${card} flex flex-col gap-3 p-5`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold">{t('clip.title')}</span>
          <span className="text-[13px] text-[#8FA3C8]">{t('clip.hint')}</span>
        </div>
        <Switch label={t('clip.title')} checked={!!s?.enabled} onChange={s ? (v) => void desktopApi!.clipboardSetEnabled(v).then(setS) : undefined} />
      </div>
      {s?.enabled && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8FA3C8]">{t('clip.count', { count: s.entries.length })}</span>
            <button type="button" className={btnGhost} disabled={!s.entries.length} onClick={() => void desktopApi!.clipboardClear().then(setS)}>{t('clip.clear')}</button>
          </div>
          <ul className="m-0 flex max-h-[260px] list-none flex-col overflow-auto p-0">
            {s.entries.map((e) => (
              <li key={e.id} className={`flex items-center gap-3 py-2 ${rowLine}`}>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={formatDate(e.at)}>{e.text}</span>
                <button type="button" className={linkBtn} onClick={() => void desktopApi!.clipboardCopy(e.id)}>{t('clip.copy')}</button>
                <button type="button" className={linkBtn} aria-label={t('clip.removeOne')} onClick={() => void desktopApi!.clipboardRemove(e.id).then(setS)}>{t('clip.remove')}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
