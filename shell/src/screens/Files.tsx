import { useState } from 'react'
import type { WindowProps } from './types'
import BWindow from '../components/BWindow'
import BIcon from '../components/BIcon'

// Sync states per WSOS-DRV-002.
type Sync = 'synced' | 'syncing' | 'pending' | 'conflict' | 'online' | 'error' | 'local'
const SYNC: Record<Sync, { label: string; cls: string; dot: string }> = {
  synced: { label: 'Synced', cls: 'bg-[#ecfdf5] text-[#047857]', dot: 'bg-[#047857]' },
  syncing: { label: 'Uploading 64%', cls: 'bg-[#eff6ff] text-[#1d4ed8]', dot: 'bg-[#1d4ed8]' },
  pending: { label: 'Waiting to sync', cls: 'bg-[#f1f5f9] text-[#475569]', dot: 'bg-[#475569]' },
  conflict: { label: 'Conflict copy', cls: 'bg-[#fffbeb] text-[#b45309]', dot: 'bg-[#b45309]' },
  online: { label: 'Online only', cls: 'bg-[#f5f3ff] text-[#6d28d9]', dot: 'bg-[#6d28d9]' },
  error: { label: 'Not synced — too large', cls: 'bg-[#fef2f2] text-[#b91c1c]', dot: 'bg-[#b91c1c]' },
  local: { label: 'Local', cls: 'bg-[#f1f5f9] text-[#334155]', dot: 'bg-[#334155]' },
}
const EXT: Record<string, string> = {
  XLS: 'bg-[#dcfce7] text-[#15803d]', DOC: 'bg-[#dbeafe] text-[#1d4ed8]', PDF: 'bg-[#fee2e2] text-[#b91c1c]',
  ZIP: 'bg-[#f1f5f9] text-[#334155]', DIR: 'bg-[#e0f2fe] text-[#0369a1]', MP4: 'bg-[#fae8ff] text-[#a21caf]',
}
interface Row { ext: string; name: string; s: Sync; mod: string; size: string; hi?: boolean }

const CLOUD_ROWS: Row[] = [
  { ext: 'DIR', name: 'SFCL website RFP', s: 'synced', mod: 'Today, 09:31', size: '—' },
  { ext: 'DOC', name: 'SFCL proposal v3.docx', s: 'syncing', mod: 'Today, 09:50', size: '6.4 MB' },
  { ext: 'XLS', name: 'TSHDA bid — pricing.xlsx', s: 'synced', mod: 'Today, 09:44 · Nimali', size: '212 KB' },
  { ext: 'XLS', name: 'TSHDA bid — pricing (conflict Hasarinda-laptop 2026-10-15).xlsx', s: 'conflict', mod: 'Today, 08:12 · offline edit', size: '208 KB', hi: true },
  { ext: 'PDF', name: 'MBSL digital media tender.pdf', s: 'online', mod: 'Yesterday, 17:05', size: '3.1 MB' },
  { ext: 'PDF', name: 'Care Me platform — clarifications.pdf', s: 'pending', mod: 'Today, 09:51', size: '480 KB' },
  { ext: 'ZIP', name: 'DOL e-AIMS submission pack.zip', s: 'synced', mod: '13 Oct', size: '24.8 MB' },
  { ext: 'MP4', name: 'Site walk-through recording.mp4', s: 'error', mod: '12 Oct', size: '6.2 GB' },
  { ext: 'DOC', name: 'Mobitel accounting RFP — notes.docx', s: 'online', mod: '10 Oct', size: '96 KB' },
]
const LOCAL_ROWS: Row[] = [
  { ext: 'DIR', name: 'Screenshots', s: 'local', mod: 'Today, 08:40', size: '—' },
  { ext: 'PDF', name: 'Invoice INV-2026-0418.pdf', s: 'local', mod: 'Today, 09:12', size: '182 KB' },
  { ext: 'ZIP', name: 'worksuite-agent-2.4.1.zip', s: 'local', mod: 'Yesterday, 16:20', size: '38.2 MB' },
  { ext: 'DOC', name: 'Meeting notes — 14 Oct.docx', s: 'local', mod: 'Yesterday, 11:02', size: '44 KB' },
]

const LOCAL_PLACES = [
  { name: 'Home', icon: 'home', note: '' },
  { name: 'Documents', icon: 'folder', note: '' },
  { name: 'Downloads', icon: 'download', note: '' },
  { name: 'KINGSTON 32 GB', icon: 'usb', note: 'Eject' },
  { name: 'Network shares', icon: 'network', note: '' },
]
const CLOUD_PLACES = [
  { name: 'My Drive', icon: 'cloud' },
  { name: 'Shared › Tenders 2026', icon: 'users' },
  { name: 'Team › Finance', icon: 'folder' },
  { name: 'Recycle bin', icon: 'trash' },
]

export default function Files({ onClose }: WindowProps) {
  const [root, setRoot] = useState<'local' | 'cloud'>('cloud')
  const [place, setPlace] = useState('Shared › Tenders 2026')
  const [query, setQuery] = useState('')
  const [alert, setAlert] = useState(true)

  const cloud = root === 'cloud'
  const folder = place.split(' › ').pop()!
  const crumbs = cloud ? ['WorkSuite Cloud', ...place.split(' › ')] : ['This Computer', place]
  const all = cloud ? (place === 'Shared › Tenders 2026' ? CLOUD_ROWS : []) : place === 'Downloads' ? LOCAL_ROWS : LOCAL_ROWS.slice(0, 1)
  const rows = all.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()))
  const go = (r: 'local' | 'cloud', p: string) => { setRoot(r); setPlace(p); setQuery('') }

  return (
    <BWindow title="Files" mark="F" markClass="bg-[#e0f2fe] text-[#0369a1]" label="Files" onClose={onClose}>
      <nav aria-label="Places" className="flex w-[260px] shrink-0 flex-col gap-1 overflow-auto border-r border-[#e2e8f0] bg-[#f8fafc] px-3 py-4">
        <div className="px-2.5 py-1 text-[11.5px] font-bold tracking-[0.06em] text-[#475569] uppercase">This Computer</div>
        {LOCAL_PLACES.map((p) => {
          const cur = !cloud && place === p.name
          return (
            <button key={p.name} type="button" aria-current={cur ? 'page' : undefined} onClick={() => go('local', p.name)}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm ${cur ? 'bg-[#dbeafe] font-semibold text-[#1e3a8a]' : 'text-[#334155] hover:bg-[#f1f5f9]'}`}>
              <BIcon name={p.icon} size={17} /><span className="grow">{p.name}</span>
              {p.note && <span className="text-[11.5px] text-[#475569]">{p.note}</span>}
            </button>
          )
        })}
        <div className="h-3" />
        <div className="px-2.5 py-1 text-[11.5px] font-bold tracking-[0.06em] text-[#475569] uppercase">WorkSuite Cloud</div>
        {CLOUD_PLACES.map((p) => {
          const cur = cloud && place === p.name
          return (
            <button key={p.name} type="button" aria-current={cur ? 'page' : undefined} onClick={() => go('cloud', p.name)}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm ${cur ? 'bg-[#dbeafe] font-semibold text-[#1e3a8a]' : 'text-[#334155] hover:bg-[#f1f5f9]'}`}>
              <BIcon name={p.icon} size={17} /><span>{p.name}</span>
            </button>
          )
        })}
        <div className="mt-auto flex flex-col gap-2 rounded-[10px] border border-[#e2e8f0] bg-white px-2.5 py-3">
          <div className="flex justify-between text-[12.5px]"><span className="text-[#334155]">Cloud storage</span><span className="text-[#475569]">18.4 of 50 GB</span></div>
          <div className="h-1.5 rounded-full bg-[#e2e8f0]" role="progressbar" aria-label="Cloud storage used" aria-valuenow={37} aria-valuemin={0} aria-valuemax={100}><div className="h-1.5 w-[37%] rounded-full bg-[#2563eb]" /></div>
          <div className="text-xs text-[#475569]">Local sync folder: ~/WorkSuite Drive</div>
        </div>
      </nav>

      <main className="flex min-w-0 grow flex-col">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-[#e2e8f0] px-5 py-3.5">
          <div className="text-sm text-[#475569]">
            {crumbs.map((c, i) => (
              <span key={i}>{i > 0 && <span aria-hidden="true"> › </span>}{i === crumbs.length - 1 ? <span className="font-semibold text-[#0f172a]">{c}</span> : c}</span>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <label className="flex h-9 w-[260px] items-center gap-2 rounded-lg border border-[#cbd5e1] px-3 text-[#475569]">
              <BIcon name="search" size={16} />
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search in ${folder}`} aria-label="Search in folder" className="min-w-0 grow border-0 text-[13px] text-[#0f172a] outline-none" />
            </label>
            {cloud && <button type="button" className="h-9 rounded-lg border border-[#cbd5e1] bg-white px-3.5 text-[13px] text-[#334155] hover:bg-[#f8fafc]">Make available offline</button>}
            <button type="button" className="h-9 rounded-lg bg-[#2563eb] px-3.5 text-[13px] font-semibold text-white hover:bg-[#1d4ed8]">{cloud ? 'Upload' : 'New folder'}</button>
          </div>
        </div>

        {cloud && alert && place === 'Shared › Tenders 2026' && (
          <div role="alert" className="mx-5 mt-3.5 flex items-center gap-3 rounded-[10px] border border-[#fde68a] bg-[#fffbeb] px-3.5 py-3 text-[13px] text-[#78350f]">
            <BIcon name="alert" />
            <span className="grow"><b>1 conflict:</b> "TSHDA bid — pricing.xlsx" was edited here and by Nimali while you were offline. Both copies were kept.</span>
            <button type="button" onClick={() => setAlert(false)} className="h-8 rounded-lg border border-[#f59e0b] bg-white px-3 text-[13px] text-[#78350f]">Compare versions</button>
          </div>
        )}

        <div className="grow overflow-auto px-5 py-3">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left text-xs text-[#475569]">
                <th className="border-b border-[#e2e8f0] px-2.5 py-2 font-semibold">Name</th>
                <th className="w-[200px] border-b border-[#e2e8f0] px-2.5 py-2 font-semibold">Sync status</th>
                <th className="w-[180px] border-b border-[#e2e8f0] px-2.5 py-2 font-semibold">Modified</th>
                <th className="w-[100px] border-b border-[#e2e8f0] px-2.5 py-2 text-right font-semibold">Size</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={r.hi ? 'bg-[#fffbeb]' : 'hover:bg-[#f8fafc]'}>
                  <td className="border-b border-[#f1f5f9] p-2.5">
                    <span className="flex items-center gap-2.5">
                      <span className={`flex size-[30px] shrink-0 items-center justify-center rounded-md text-[10px] font-bold ${EXT[r.ext]}`}>{r.ext}</span>
                      <span>{r.name}</span>
                    </span>
                  </td>
                  <td className="border-b border-[#f1f5f9] p-2.5">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs ${SYNC[r.s].cls}`}>
                      <span className={`size-[7px] rounded-full ${SYNC[r.s].dot}`} />{SYNC[r.s].label}
                    </span>
                  </td>
                  <td className="border-b border-[#f1f5f9] p-2.5 text-[#475569]">{r.mod}</td>
                  <td className="border-b border-[#f1f5f9] p-2.5 text-right text-[#475569]">{r.size}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-[#475569]">{query ? 'No files match your search.' : 'This folder is empty.'}</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="flex h-10 shrink-0 items-center gap-4 border-t border-[#e2e8f0] bg-[#f8fafc] px-5 text-[12.5px] text-[#475569]">
          <span>{rows.length} items</span>
          {cloud && <span>Uploading 1 of 2 · 4.1 MB left</span>}
          <span className="ml-auto">{cloud ? 'Last full sync 09:47 · Online' : 'Local disk · 212 GB free'}</span>
        </div>
      </main>
    </BWindow>
  )
}
