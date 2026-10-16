// Buttons for an app notification's actions and its dismiss, in the notification centre (WSOS-INT-007). The lock
// screen never renders these; it shows the app name only.
import { appIdOf, notificationsApi } from '../lib/appNotifications'
import type { Notice } from '../lib/syncNotices'
import { t } from '../i18n'

const btn = 'cursor-pointer rounded-md bg-white/[0.08] px-2.5 py-1 text-xs text-[#E8EEFA] hover:bg-white/[0.14]'

export function AppNoticeActions({ notice, onDone }: { notice: Notice; onDone: () => void }) {
  const id = appIdOf(notice)
  const api = notificationsApi()
  if (id === null || !api) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <span className="mr-auto text-[11px] text-[#8FA3C8]">{notice.app}</span>
      {/* Open: the notification's default action; the shell also brings the app's window forward. */}
      <button type="button" className={btn} onClick={() => { void api.invoke(id, 'default'); onDone() }}>{t('common.open')}</button>
      {(notice.actions ?? []).filter((a) => a.key !== 'default').map((a) => (
        <button key={a.key} type="button" className={btn} onClick={() => { void api.invoke(id, a.key); onDone() }}>{a.label}</button>
      ))}
      <button type="button" className={btn} onClick={() => { void api.dismiss(id); onDone() }}>{t('common.dismiss')}</button>
    </div>
  )
}

/** "Clear all" also closes the apps' notifications on the server, so they get NotificationClosed. */
export function dismissAppNotices(list: Notice[]) {
  const api = notificationsApi()
  for (const n of list) { const id = appIdOf(n); if (id !== null) void api?.dismiss(id) }
}
