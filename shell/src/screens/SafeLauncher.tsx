// Minimal launcher (WSOS-SES-005): worksuite-recovery-launcher.service starts the shell with --safe after the normal
// shell crashed 3 times within 60 s. It offers installed apps (no terminals), Settings, Log out and Report problem,
// and nothing that needs the parts of the shell that may be broken (no panel, bridge or WorkSuite web app windows).
import { useEffect, useState } from 'react'
import { os, type InstalledApp } from '../lib/os'
import { desktopApi } from '../lib/desktopApi'
import { safeApps } from '../lib/launcher'
import Settings from './Settings'
import { t } from '../i18n'

const tile = 'flex cursor-pointer flex-col items-start gap-1 rounded-xl border border-[rgba(127,178,255,0.2)] bg-white/[0.06] px-4 py-3 text-left text-sm text-[#E8EEFA] hover:bg-white/[0.12]'
const action = 'cursor-pointer rounded-[10px] border border-[rgba(127,178,255,0.3)] px-4 py-2.5 text-sm font-medium text-[#E8EEFA] hover:bg-white/10'

export default function SafeLauncher() {
  const [apps, setApps] = useState<InstalledApp[] | null>(null)
  const [settings, setSettings] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  useEffect(() => { void os.installedApps().then((r) => setApps(safeApps(r.apps))).catch(() => setApps([])) }, [])
  const saveReport = async () => {
    if (!desktopApi) { setReport(t('safe.reportFailed')); return }
    const r = await desktopApi.problemReport().catch(() => null)
    setReport(r?.ok ? t('safe.reportSaved', { file: r.value }) : t('safe.reportFailed'))
  }
  if (settings) return <Settings onClose={() => setSettings(false)} />
  return (
    <main className="flex h-full flex-col gap-6 overflow-auto bg-[#0A1A3D] px-10 py-8 font-sans text-[#E8EEFA]">
      <header className="flex flex-col gap-2">
        <h1 className="m-0 text-2xl font-bold">{t('safe.title')}</h1>
        <p className="m-0 max-w-[720px] text-sm text-[#C9D6EE]">{t('safe.body')}</p>
      </header>
      <div className="flex flex-wrap gap-2.5">
        <button type="button" className={action} onClick={() => setSettings(true)}>{t('launcher.settings')}</button>
        <button type="button" className={action} onClick={() => void saveReport()}>{t('safe.report')}</button>
        <button type="button" className={action} onClick={() => void os.logout()}>{t('safe.logout')}</button>
      </div>
      {report && <p role="status" className="m-0 text-sm text-[#C9D6EE]">{report}</p>}
      <section aria-label={t('safe.apps')} className="flex flex-col gap-3">
        <h2 className="m-0 text-xs font-normal tracking-[0.08em] text-[#8FA3C8] uppercase">{t('safe.apps')}</h2>
        {apps === null ? <p className="m-0 text-sm text-[#8FA3C8]">{t('common.loading')}</p>
          : apps.length === 0 ? <p className="m-0 text-sm text-[#8FA3C8]">{t('launcher.noApps')}</p>
          : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
              {apps.map((a) => (
                <button key={a.id} type="button" className={tile} onClick={() => void os.launchApp(a.id)}>
                  <span className="font-semibold">{a.name}</span>
                  {a.generic_name && <span className="text-xs text-[#8FA3C8]">{a.generic_name}</span>}
                </button>
              ))}
            </div>
          )}
      </section>
    </main>
  )
}
