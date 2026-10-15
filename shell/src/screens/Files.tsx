import { useEffect, useState } from 'react'
import type { WindowProps } from './types'
import BWindow from '../components/BWindow'
import BIcon from '../components/BIcon'
import { formatBytes, os, type FileEntry } from '../lib/os'
import { formatDate, formatNumber, messages, t } from '../i18n'

// Sync states per WSOS-DRV-002, plus "folder", "local" (outside Drive) and "unknown" (sync service not running).
const SYNC_LABEL = messages({ synced: 'files.sync.synced', syncing: 'files.sync.syncing', pending: 'files.sync.pending', conflict: 'files.sync.conflict', 'online-only': 'files.sync.online', error: 'files.sync.error', local: 'files.sync.local', unknown: 'files.sync.unknown' })
const SYNC: Record<string, { label: string; cls: string; dot: string }> = {
  synced: { get label() { return SYNC_LABEL.synced }, cls: 'bg-[#ecfdf5] text-[#047857]', dot: 'bg-[#047857]' },
  syncing: { get label() { return SYNC_LABEL.syncing }, cls: 'bg-[#eff6ff] text-[#1d4ed8]', dot: 'bg-[#1d4ed8]' },
  pending: { get label() { return SYNC_LABEL.pending }, cls: 'bg-[#f1f5f9] text-[#475569]', dot: 'bg-[#475569]' },
  conflict: { get label() { return SYNC_LABEL.conflict }, cls: 'bg-[#fffbeb] text-[#b45309]', dot: 'bg-[#b45309]' },
  'online-only': { get label() { return SYNC_LABEL['online-only'] }, cls: 'bg-[#f5f3ff] text-[#6d28d9]', dot: 'bg-[#6d28d9]' },
  error: { get label() { return SYNC_LABEL.error }, cls: 'bg-[#fef2f2] text-[#b91c1c]', dot: 'bg-[#b91c1c]' },
  local: { get label() { return SYNC_LABEL.local }, cls: 'bg-[#f1f5f9] text-[#334155]', dot: 'bg-[#334155]' },
  unknown: { get label() { return SYNC_LABEL.unknown }, cls: 'bg-[#f1f5f9] text-[#475569]', dot: 'bg-[#94a3b8]' },
}
const KIND: Record<string, string> = {
  XLS: 'bg-[#dcfce7] text-[#15803d]', DOC: 'bg-[#dbeafe] text-[#1d4ed8]', PDF: 'bg-[#fee2e2] text-[#b91c1c]',
  ZIP: 'bg-[#f1f5f9] text-[#334155]', DIR: 'bg-[#e0f2fe] text-[#0369a1]', MP4: 'bg-[#fae8ff] text-[#a21caf]', IMG: 'bg-[#fef3c7] text-[#92400e]', FILE: 'bg-[#f1f5f9] text-[#334155]',
}
function kind(e: FileEntry): string {
  if (e.dir) return 'DIR'
  const x = e.name.split('.').pop()?.toLowerCase() ?? ''
  if (['xls', 'xlsx', 'ods', 'csv'].includes(x)) return 'XLS'
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(x)) return 'DOC'
  if (x === 'pdf') return 'PDF'
  if (['zip', 'tar', 'gz', 'xz', '7z'].includes(x)) return 'ZIP'
  if (['mp4', 'mkv', 'webm', 'mov'].includes(x)) return 'MP4'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(x)) return 'IMG'
  return 'FILE'
}
const when = (ms: number | null) => (ms == null ? '—' : formatDate(ms))

/** Shortcuts under Home shown in the sidebar when they exist. */
const HOME_PLACES = [{ key: 'home', get label() { return t('files.home') }, rel: '', icon: 'home' }, { key: 'docs', get label() { return t('files.documents') }, rel: 'Documents', icon: 'folder' }, { key: 'dl', get label() { return t('files.downloads') }, rel: 'Downloads', icon: 'download' }]

export default function Files({ onClose }: WindowProps) {
  const [roots, setRoots] = useState<{ id: string; label: string }[]>([])
  const [driveExists, setDriveExists] = useState(true)
  const [root, setRoot] = useState('drive')
  const [rel, setRel] = useState('')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Awaited<ReturnType<typeof os.filesStatus>> | null>(null)
  const [conflictsDismissed, setConflictsDismissed] = useState(false)
  const [winApp, setWinApp] = useState<string | null>(null)
  const [readOnly, setReadOnly] = useState<string | null>(null)

  useEffect(() => { void os.filesRoots().then((r) => { setRoots(r.roots); setDriveExists(r.drive_exists) }) }, [])

  const load = () => {
    setEntries(null); setError(null)
    void os.filesList(root, rel).then((r) => (r.ok ? setEntries(r.value) : setError(t('files.cantOpen'))))
    void os.filesStatus(root).then(setStatus)
  }
  useEffect(load, [root, rel])

  const cloud = root === 'drive'
  const go = (r: string, p: string) => { setRoot(r); setRel(p); setQuery(''); setConflictsDismissed(false) }
  const open = (e: FileEntry) => {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.dir) return go(root, p)
    // Windows programs are never run; the main process refuses them and this explains why (WSOS-LCH-003).
    if (e.local) void os.filesOpen(root, p).then((r) => { if (!r.ok && r.error === 'windows_program') setWinApp(e.name); if (r.ok && (r.value as unknown) === 'read_only_copy') setReadOnly(e.name) })
  }
  const rootLabel = roots.find((r) => r.id === root)?.label ?? (cloud ? 'WorkSuite Drive' : t('files.home'))
  const crumbs = [{ label: cloud ? 'WorkSuite Cloud' : rootLabel, rel: '' }, ...rel.split('/').filter(Boolean).map((seg, i, all) => ({ label: seg, rel: all.slice(0, i + 1).join('/') }))]
  const rows = (entries ?? []).filter((e) => e.name.toLowerCase().includes(query.trim().toLowerCase()))
  const conflicts = (entries ?? []).filter((e) => e.state === 'conflict')
  const counts = status?.drive?.states ?? {}
  const busy = (counts.syncing ?? 0) + (counts.pending ?? 0)

  const placeBtn = (key: string, label: string, icon: string, current: boolean, onClick: () => void, note?: string) => (
    <button key={key} type="button" aria-current={current ? 'page' : undefined} onClick={onClick}
      className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm ${current ? 'bg-[#dbeafe] font-semibold text-[#1e3a8a]' : 'text-[#334155] hover:bg-[#f1f5f9]'}`}>
      <BIcon name={icon} size={17} /><span className="grow truncate">{label}</span>{note && <span className="text-[11.5px] text-[#475569]">{note}</span>}
    </button>
  )

  return (
    <BWindow title={t('files.title')} mark="F" markClass="bg-[#e0f2fe] text-[#0369a1]" label={t('files.title')} onClose={onClose}>
      <nav aria-label={t('files.places')} className="flex w-[260px] shrink-0 flex-col gap-1 overflow-auto border-r border-[#e2e8f0] bg-[#f8fafc] px-3 py-4">
        <div className="px-2.5 py-1 text-[11.5px] font-bold tracking-[0.06em] text-[#475569] uppercase">{t('files.thisComputer')}</div>
        {HOME_PLACES.map((p) => placeBtn(p.key, p.label, p.icon, root === 'home' && rel === p.rel, () => go('home', p.rel)))}
        {roots.filter((r) => r.id.startsWith('media:')).map((r) => placeBtn(r.id, r.label, 'usb', root === r.id && !rel, () => go(r.id, ''), 'USB'))}
        <div className="h-3" />
        <div className="px-2.5 py-1 text-[11.5px] font-bold tracking-[0.06em] text-[#475569] uppercase">WorkSuite Cloud</div>
        {placeBtn('drive', 'WorkSuite Drive', 'cloud', cloud && !rel, () => go('drive', ''))}
        <div className="mt-auto flex flex-col gap-1.5 rounded-[10px] border border-[#e2e8f0] bg-white px-2.5 py-3 text-xs text-[#475569]">
          <span className="text-[12.5px] text-[#334155]">{t('files.localFolder')}</span>
          <span>~/WorkSuite Drive{driveExists ? '' : ` ${t('files.notCreated')}`}</span>
        </div>
      </nav>

      <main className="flex min-w-0 grow flex-col">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-[#e2e8f0] px-5 py-3.5">
          <nav aria-label={t('files.path')} className="text-sm text-[#475569]">
            {crumbs.map((c, i) => (
              <span key={c.rel + i}>
                {i > 0 && <span aria-hidden="true"> › </span>}
                {i === crumbs.length - 1 ? <span className="font-semibold text-[#0f172a]">{c.label}</span>
                  : <button type="button" onClick={() => go(root, c.rel)} className="hover:text-[#0f172a] hover:underline">{c.label}</button>}
              </span>
            ))}
          </nav>
          <div className="ml-auto flex gap-2">
            <label className="flex h-9 w-[260px] items-center gap-2 rounded-lg border border-[#cbd5e1] px-3 text-[#475569]">
              <BIcon name="search" size={16} />
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('files.searchIn', { folder: crumbs[crumbs.length - 1].label })} aria-label={t('files.searchFolder')} className="min-w-0 grow border-0 text-[13px] text-[#0f172a] outline-none" />
            </label>
          </div>
        </div>

        {readOnly && (
          <div role="status" className="mx-5 mt-3.5 flex items-center gap-3 rounded-[10px] border border-[#bfdbfe] bg-[#eff6ff] px-3.5 py-3 text-[13px] text-[#1e3a8a]">
            <BIcon name="alert" />
            <span className="grow">{t('files.readOnlyCopy', { name: readOnly })}</span>
            <button type="button" onClick={() => setReadOnly(null)} className="h-8 rounded-lg border border-[#93c5fd] bg-white px-3 text-[13px] text-[#1e3a8a]">{t('common.dismiss')}</button>
          </div>
        )}
        {winApp && (
          <div role="alert" className="mx-5 mt-3.5 flex items-center gap-3 rounded-[10px] border border-[#bfdbfe] bg-[#eff6ff] px-3.5 py-3 text-[13px] text-[#1e3a8a]">
            <BIcon name="alert" />
            <span className="grow"><b>{t('files.winTitle')}</b> {t('files.winBody', { name: winApp })}</span>
            <button type="button" onClick={() => setWinApp(null)} className="h-8 rounded-lg border border-[#93c5fd] bg-white px-3 text-[13px] text-[#1e3a8a]">{t('common.dismiss')}</button>
          </div>
        )}

        {cloud && conflicts.length > 0 && !conflictsDismissed && (
          <div role="alert" className="mx-5 mt-3.5 flex items-center gap-3 rounded-[10px] border border-[#fde68a] bg-[#fffbeb] px-3.5 py-3 text-[13px] text-[#78350f]">
            <BIcon name="alert" />
            <span className="grow"><b>{t('files.conflicts', { count: formatNumber(conflicts.length) })}</b> {t('files.conflictBody')}</span>
            <button type="button" onClick={() => setConflictsDismissed(true)} className="h-8 rounded-lg border border-[#f59e0b] bg-white px-3 text-[13px] text-[#78350f]">{t('common.dismiss')}</button>
          </div>
        )}

        <div className="grow overflow-auto px-5 py-3">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left text-xs text-[#475569]">
                <th className="border-b border-[#e2e8f0] px-2.5 py-2 font-semibold">{t('files.col.name')}</th>
                <th className="w-[200px] border-b border-[#e2e8f0] px-2.5 py-2 font-semibold">{cloud ? t('files.col.sync') : t('files.col.kind')}</th>
                <th className="w-[200px] border-b border-[#e2e8f0] px-2.5 py-2 font-semibold">{t('files.col.modified')}</th>
                <th className="w-[100px] border-b border-[#e2e8f0] px-2.5 py-2 text-right font-semibold">{t('files.col.size')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const k = kind(e), st = SYNC[e.state]
                return (
                  <tr key={e.name} className={e.state === 'conflict' ? 'bg-[#fffbeb]' : 'hover:bg-[#f8fafc]'}>
                    <td className="border-b border-[#f1f5f9] p-2.5">
                      <button type="button" onDoubleClick={() => open(e)} onKeyDown={(ev) => { if (ev.key === 'Enter') open(e) }} onClick={() => { if (e.dir) open(e) }}
                        disabled={!e.dir && !e.local} title={!e.dir && !e.local ? t('files.onlineOnly') : undefined}
                        className="flex items-center gap-2.5 text-left disabled:cursor-default">
                        <span className={`flex size-[30px] shrink-0 items-center justify-center rounded-md text-[10px] font-bold ${KIND[k]}`}>{k}</span>
                        <span>{e.name}</span>
                      </button>
                    </td>
                    <td className="border-b border-[#f1f5f9] p-2.5">
                      {cloud && st ? (
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs ${st.cls}`}><span className={`size-[7px] rounded-full ${st.dot}`} />{st.label}</span>
                      ) : <span className="text-[#475569]">{e.dir ? t('files.folder') : k === 'FILE' ? t('files.file') : k}</span>}
                    </td>
                    <td className="border-b border-[#f1f5f9] p-2.5 text-[#475569]">{when(e.modified)}</td>
                    <td className="border-b border-[#f1f5f9] p-2.5 text-right text-[#475569]">{e.dir ? '—' : formatBytes(e.size)}</td>
                  </tr>
                )
              })}
              {entries && rows.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-[#475569]">{query ? t('files.noMatch') : t('files.empty')}</td></tr>}
              {!entries && !error && <tr><td colSpan={4} className="p-6 text-center text-[#475569]">{t('common.loading')}</td></tr>}
              {error && <tr><td colSpan={4} className="p-6 text-center text-[#b91c1c]">{error}</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="flex h-10 shrink-0 items-center gap-4 border-t border-[#e2e8f0] bg-[#f8fafc] px-5 text-[12.5px] text-[#475569]">
          <span>{t('files.items', { count: formatNumber(rows.length) })}</span>
          {cloud && status?.drive && busy > 0 && <span>{t('files.waiting', { count: formatNumber(busy) })}</span>}
          <span className="ml-auto">
            {cloud
              ? status?.drive ? `${t('files.lastSync', { when: status.drive.last_sync ? when(status.drive.last_sync) : t('settings.about.notYet') })} · ${status.drive.service_state === 'idle' ? t('files.online') : status.drive.service_state === 'offline' ? t('files.offline') : status.drive.service_state}` : t('files.noService')
              : status?.free_bytes != null ? t('files.free', { size: formatBytes(status.free_bytes) }) : ''}
          </span>
        </div>
      </main>
    </BWindow>
  )
}
