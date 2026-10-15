// Shared pieces of the Files window (boards FMSide, FM1–FM6): icons, kinds, dates and the sidebar.
import { formatBytes, type FileEntry, type FilePlaces } from '../../lib/os'
import { formatDate, t, type MessageKey } from '../../i18n'

export const C = {
  page: '#0A1A3D', side: '#071330', bar: '#0C1E46', card: 'rgba(14,32,72,0.6)', line: 'rgba(127,178,255,0.12)',
  text: '#E8EEFA', soft: '#C9D6EE', muted: '#8FA3C8', dim: '#5E739C', blue: '#1F6BFF', cyan: '#18D4F0', link: '#7FB2FF',
}

export const P = {
  folder: 'M3 6h6l2 2h10v11H3z', home: 'M3 11l9-7 9 7v9H3z', recent: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z', download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  pictures: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6', music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  videos: 'M3 5h18v14H3zM10 9l5 3-5 3z', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', usb: 'M9 3h6v6H9zM6 9h12v12H6z',
  cloud: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z', open: 'M5 5h14v14H5zM9 9h6v6', chevron: 'M9 6l6 6-6 6',
  cut: 'M6 9a3 3 0 1 0 0-.01M6 15a3 3 0 1 0 0 .01M8.5 10.5L20 4M8.5 13.5L20 20', copy: 'M8 8h12v12H8zM4 16V4h12',
  duplicate: 'M8 8h12v12H8zM14 11v6M11 14h6', rename: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4', share: 'M4 12v8h16v-8M12 3v13M7 8l5-5 5 5',
  compress: 'M8 3h8v18H8zM12 6v2M12 10v2M12 14v2', info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  paste: 'M9 4h6v3H9zM6 6h12v15H6z', back: 'M15 6l-6 6 6 6', fwd: 'M9 6l6 6-6 6', grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M4 6h16M4 12h16M4 18h16', close: 'M6 6l12 12M18 6L6 18',
}

export function Svg({ d, size = 16, stroke = 'currentColor', width = 2, fill = 'none' }: { d: string; size?: number; stroke?: string; width?: number; fill?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={fill === 'none' ? stroke : 'none'} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
}

// File kinds by extension: badge colour (board palette) and the kind name.
const KINDS: [string[], string, MessageKey | null][] = [
  [['doc', 'docx', 'odt', 'rtf', 'txt'], '#1F6BFF', 'files.kind.doc'],
  [['xls', 'xlsx', 'ods', 'csv'], '#2E9E6A', 'files.kind.sheet'],
  [['pdf'], '#D9452B', 'files.kind.pdf'],
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'], '#7A4FE0', 'files.kind.image'],
  [['ppt', 'pptx', 'odp'], '#D9572B', 'files.kind.slides'],
  [['md'], '#5E739C', 'files.kind.md'],
  [['mp4', 'mkv', 'webm', 'mov', 'avi'], '#D9572B', 'files.kind.video'],
  [['mp3', 'ogg', 'flac', 'wav', 'm4a'], '#B7791F', 'files.kind.audio'],
  [['zip', 'tar', 'gz', 'xz', '7z', 'bz2', 'zst'], '#5E739C', 'files.kind.archive'],
]
export function kindOf(name: string, dir: boolean) {
  if (dir) return { ext: '▣', badge: 'FOLDER', color: C.blue, label: t('files.folder'), image: false }
  const x = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const k = KINDS.find((k) => k[0].includes(x))
  return { ext: (x || '—').toUpperCase().slice(0, 4), badge: (x || '—').toUpperCase().slice(0, 4), color: k?.[1] ?? '#5E739C', label: k?.[2] ? t(k[2]) : t('files.file'), image: k?.[2] === 'files.kind.image' }
}
export const thumbBg = (image: boolean) => (image ? 'linear-gradient(135deg,#1F4FB0,#18D4F0)' : 'rgba(4,10,26,0.5)')
const FOLDER_COLORS = ['#1F6BFF', '#2E9E6A', '#B7791F', '#5E739C', '#7A4FE0', '#D9572B']
export const folderColor = (i: number) => FOLDER_COLORS[i % FOLDER_COLORS.length]

/** "Today", "Yesterday", "12 Oct", or "12 Oct 2025" for other years. */
export function day(ms: number | null): string {
  if (ms == null) return '—'
  const d = new Date(ms), now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= start) return t('files.today')
  if (ms >= start - 86_400_000) return t('files.yesterday')
  return formatDate(d, d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}
export const sizeOf = (e: Pick<FileEntry, 'dir' | 'size' | 'items'>) => (e.dir ? (e.items != null ? t('files.itemsShort', { count: e.items }) : '—') : formatBytes(e.size))

export type Place = { kind: 'dir'; root: string; rel: string } | { kind: 'recent' } | { kind: 'starred' } | { kind: 'trash' }

const FOLDER_ICON: Record<string, [string, MessageKey]> = {
  Documents: [P.folder, 'files.documents'], Downloads: [P.download, 'files.downloads'], Pictures: [P.pictures, 'files.pictures'], Music: [P.music, 'files.music'], Videos: [P.videos, 'files.videos'],
}
export const folderLabel = (name: string) => (FOLDER_ICON[name] ? t(FOLDER_ICON[name][1]) : name)

export function FilesSide({ place, places, drive, onGo, onEject }: {
  place: Place; places: FilePlaces | null; drive: string | null; onGo: (p: Place) => void; onEject: (id: string, label: string) => void
}) {
  const is = (p: Place) => JSON.stringify(p) === JSON.stringify(place)
  type Item = { key: string; label: string; icon: string; to: Place; meta?: string; eject?: () => void }
  const sections: [string, Item[]][] = [
    [t('files.quickAccess'), [
      { key: 'home', label: t('files.home'), icon: P.home, to: { kind: 'dir', root: 'home', rel: '' } },
      { key: 'recent', label: t('files.recent'), icon: P.recent, to: { kind: 'recent' } },
      { key: 'starred', label: t('files.starred'), icon: P.star, to: { kind: 'starred' } },
    ]],
    [t('files.foldersSection'), [
      ...(places?.folders ?? []).map((f) => ({ key: f, label: folderLabel(f), icon: FOLDER_ICON[f]?.[0] ?? P.folder, to: { kind: 'dir', root: 'home', rel: f } as Place })),
      { key: 'trash', label: t('files.trash'), icon: P.trash, to: { kind: 'trash' } },
    ]],
    [t('files.devices'), [
      ...(places?.media ?? []).map((m) => ({ key: m.id, label: m.label, icon: P.usb, to: { kind: 'dir', root: m.id, rel: '' } as Place, eject: () => onEject(m.id, m.label) })),
      { key: 'drive', label: 'WorkSuite Drive', icon: P.cloud, to: { kind: 'dir', root: 'drive', rel: '' }, meta: drive ?? undefined },
    ]],
  ]
  const disk = places?.disk
  return (
    <nav aria-label={t('files.places')} className="box-border flex h-full w-[220px] shrink-0 flex-col gap-4 overflow-auto px-3 py-[18px]" style={{ background: C.side, borderRight: `1px solid ${C.line}`, color: C.text }}>
      <div className="flex items-center gap-2.5 px-2 py-1">
        <Svg d={P.folder} size={22} stroke={C.cyan} />
        <span className="text-[15px] font-semibold">{t('files.title')}</span>
      </div>
      {sections.map(([name, items]) => (
        <div key={name} className="flex flex-col gap-px">
          <span className="px-2.5 pb-1.5 text-[11px] tracking-[0.08em] uppercase" style={{ color: C.dim }}>{name}</span>
          {items.map((n) => {
            const on = is(n.to) || (n.key !== 'home' && place.kind === 'dir' && n.to.kind === 'dir' && n.to.root === place.root && n.to.rel !== '' && place.rel.startsWith(n.to.rel + '/'))
              || (place.kind === 'dir' && n.to.kind === 'dir' && n.to.rel === '' && n.to.root !== 'home' && n.to.root === place.root)
            return (
              <div key={n.key} className="flex items-center rounded-lg" style={{ background: on ? 'rgba(31,107,255,0.2)' : 'transparent' }}>
                <button type="button" aria-current={on ? 'page' : undefined} onClick={() => onGo(n.to)}
                  className="flex min-w-0 grow cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] hover:bg-white/5"
                  style={{ color: on ? '#FFFFFF' : C.soft, fontWeight: on ? 600 : 400 }}>
                  <Svg d={n.icon} stroke={on ? C.cyan : C.muted} />
                  <span className="truncate">{n.label}</span>
                  {n.meta && <span className="ml-auto text-[11px]" style={{ color: C.dim }}>{n.meta}</span>}
                </button>
                {n.eject && <button type="button" aria-label={t('files.eject', { name: n.label })} title={t('files.eject', { name: n.label })} onClick={n.eject} className="mr-1 cursor-pointer rounded px-1.5 text-[11px] hover:bg-white/10" style={{ color: C.dim }}>{'⏏'}</button>}
              </div>
            )
          })}
        </div>
      ))}
      <div role="group" aria-label={t('files.storageLabel')} className="mt-auto flex flex-col gap-2 rounded-[10px] px-2.5 py-3" style={{ background: C.card }}>
        {disk ? <>
          <div className="flex justify-between text-xs"><span>{disk.device}</span><span style={{ color: C.muted }}>{t('files.storage', { used: formatBytes(disk.used), total: formatBytes(disk.total) })}</span></div>
          <div className="h-[5px] overflow-hidden rounded-[3px]" style={{ background: 'rgba(127,178,255,0.15)' }}>
            <div className="h-full" style={{ width: `${Math.round((disk.used / Math.max(1, disk.total)) * 100)}%`, background: `linear-gradient(90deg, ${C.blue}, ${C.cyan})` }} />
          </div>
        </> : <span className="text-xs" style={{ color: C.muted }}>{t('files.storageUnknown')}</span>}
      </div>
    </nav>
  )
}
