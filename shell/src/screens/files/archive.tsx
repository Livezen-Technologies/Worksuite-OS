// Archives in Files: the Compress… dialog, the password and "very large" prompts of archive jobs, and the read-only
// archive view ("Open archive"). The work itself runs in the main process (electron/archives.ts).
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, os, type ArchiveEntry, type ArchiveFormat, type ArchiveListing, type CompressOptions, type FileJob } from '../../lib/os'
import { formatNumber, t, type MessageKey } from '../../i18n'
import { archiveKind, stemOf } from '../../../electron/archiveKinds'
import { C, Modal, P, Svg, day, kindOf } from './parts'

export { archiveKind, stemOf }
const btn = 'cursor-pointer disabled:cursor-default'
const FORMATS: ArchiveFormat[] = ['zip', '7z', 'tar.gz', 'tar.xz']
const LEVELS: [number, MessageKey][] = [[1, 'files.arc.levelFast'], [5, 'files.arc.levelNormal'], [9, 'files.arc.levelBest']]
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s)

const ERR: Record<string, MessageKey> = {
  unsafe: 'files.arc.err.unsafe', bomb: 'files.arc.err.bomb', no_space: 'files.arc.err.noSpace', tool_missing: 'files.arc.err.toolMissing',
  password_unsupported: 'files.arc.err.pwUnsupported', password_ascii: 'files.arc.passwordAscii', exists: 'files.err.exists',
}
/** The message for an archive job's or listing's error code. */
export const archiveError = (code: string | null | undefined) => t(ERR[code ?? ''] ?? 'files.arc.err.failed')

const field = 'h-10 rounded-lg px-3 text-sm outline-none'
const fieldStyle = (on = true) => ({ background: 'var(--ws-g-field)', border: `1px solid ${on ? C.blue : 'var(--ws-g-line)'}`, color: C.text })

function Chips<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={`${btn} rounded-full px-3.5 py-1.5 font-mono text-xs`} style={{ border: `1px solid ${value === v ? C.blue : 'var(--ws-g-line)'}`, background: value === v ? 'rgba(31,107,255,0.22)' : 'transparent' }}>{text}</button>
      ))}
    </div>
  )
}

/** Compress…: format, archive name, compression level and an optional password (zip and 7z, AES-256). */
export function CompressDialog({ names, onCancel, onSubmit }: { names: string[]; onCancel: () => void; onSubmit: (o: CompressOptions) => void }) {
  const [format, setFormat] = useState<ArchiveFormat>('zip')
  const [name, setName] = useState(() => (names.length === 1 ? (names[0].includes('.') && !names[0].startsWith('.') ? names[0].slice(0, names[0].lastIndexOf('.')) : names[0]) : t('files.kind.archive')))
  const [level, setLevel] = useState(5)
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const canPw = format === 'zip' || format === '7z'
  const badPw = canPw && format === 'zip' && !ascii(pw)
  const ok = name.trim() && !name.includes('/') && !name.trim().startsWith('.') && !badPw
  const title = names.length === 1 ? t('files.arc.compressOne', { name: names[0] }) : t('files.arc.compressMany', { count: formatNumber(names.length) })
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  return (
    <Modal label={title} wide>
      <h2 className="m-0 truncate text-[19px] font-bold">{title}</h2>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit({ format, name: name.trim(), level, password: canPw && pw ? pw : null }) }}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}>
        <label className="flex flex-col gap-1.5 text-xs" style={{ color: C.muted }}>{t('files.arc.name')}
          <span className="flex items-center gap-2">
            <input ref={ref} value={name} onChange={(e) => setName(e.target.value)} className={`${field} min-w-0 grow`} style={fieldStyle()} />
            <span className="font-mono text-sm" style={{ color: C.soft }}>{`.${format}`}</span>
          </span>
        </label>
        <div className="flex flex-col gap-1.5 text-xs" style={{ color: C.muted }}>{t('files.arc.format')}
          <Chips label={t('files.arc.format')} value={format} options={FORMATS.map((f) => [f, f])} onChange={setFormat} />
        </div>
        <div className="flex flex-col gap-1.5 text-xs" style={{ color: C.muted }}>{t('files.arc.level')}
          <Chips label={t('files.arc.level')} value={level} options={LEVELS.map(([v, k]) => [v, t(k)])} onChange={setLevel} />
        </div>
        <label className="flex flex-col gap-1.5 text-xs" style={{ color: C.muted }}>{t('files.arc.password')}
          <input type={show ? 'text' : 'password'} value={canPw ? pw : ''} disabled={!canPw} autoComplete="new-password" onChange={(e) => setPw(e.target.value)}
            className={`${field} disabled:opacity-40`} style={{ ...fieldStyle(canPw), borderColor: badPw ? '#FF8A7A' : undefined }} />
        </label>
        <label className="-mt-2 flex items-center gap-2 text-xs" style={{ color: C.soft }}>
          <input type="checkbox" checked={show} disabled={!canPw} onChange={(e) => setShow(e.target.checked)} style={{ accentColor: C.blue }} />{t('files.arc.showPassword')}
        </label>
        <p role={badPw ? 'alert' : undefined} className="m-0 text-xs" style={{ color: badPw ? '#FFB4A8' : C.muted }}>
          {!canPw ? t('files.arc.passwordNone') : badPw ? t('files.arc.passwordAscii') : pw ? t('files.arc.passwordHint') : ' '}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${btn} rounded-[10px] px-4 py-2.5 text-sm`} style={{ border: '1px solid rgba(127,178,255,0.25)' }}>{t('common.cancel')}</button>
          <button type="submit" disabled={!ok} className={`${btn} rounded-[10px] px-[18px] py-2.5 text-sm font-semibold disabled:opacity-40`} style={{ background: C.blue }}>{t('files.arc.create')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** The password of an encrypted archive; used by jobs and by the archive view. */
export function PasswordDialog({ name, wrong, onCancel, onSubmit }: { name: string; wrong: boolean; onCancel: () => void; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const title = t('files.arc.pwTitle', { name })
  return (
    <Modal label={title}>
      <h2 className="m-0 text-[19px] font-bold break-words">{title}</h2>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (pw) onSubmit(pw) }} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}>
        <p className="m-0 text-sm" style={{ color: C.soft }}>{t('files.arc.pwBody')}</p>
        <label className="flex flex-col gap-1.5 text-xs" style={{ color: C.muted }}>{t('files.arc.pwLabel')}
          <input autoFocus type={show ? 'text' : 'password'} value={pw} autoComplete="off" onChange={(e) => setPw(e.target.value)} className={field} style={{ ...fieldStyle(), borderColor: wrong ? '#FF8A7A' : C.blue }} />
        </label>
        <label className="-mt-2 flex items-center gap-2 text-xs" style={{ color: C.soft }}>
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} style={{ accentColor: C.blue }} />{t('files.arc.showPassword')}
        </label>
        {wrong && <p role="alert" className="m-0 text-[13px]" style={{ color: '#FFB4A8' }}>{t('files.arc.pwWrong')}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${btn} rounded-[10px] px-4 py-2.5 text-sm`} style={{ border: '1px solid rgba(127,178,255,0.25)' }}>{t('common.cancel')}</button>
          <button type="submit" disabled={!pw} className={`${btn} rounded-[10px] px-[18px] py-2.5 text-sm font-semibold disabled:opacity-40`} style={{ background: C.blue }}>{t('files.arc.unlock')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Archive-bomb guard: the archive would write more than the limit (or a stream kept growing past it). */
export function LargeDialog({ job }: { job: FileJob }) {
  const a = job.ask ?? {}
  const vars = { name: job.name ?? '', size: formatBytes(a.bytes ?? job.bytes_done), ratio: formatNumber(a.ratio ?? 0) }
  return (
    <Modal label={t('files.arc.bigTitle')}>
      <h2 className="m-0 text-[19px] font-bold">{t('files.arc.bigTitle')}</h2>
      <p className="m-0 text-sm" style={{ color: C.soft }}>{a.bytes == null ? t('files.arc.bigBodyStream', vars) : t('files.arc.bigBody', vars)}</p>
      <div className="flex justify-end gap-2">
        <button type="button" autoFocus onClick={() => void os.filesResolve(job.id, 'cancel', false)} className={`${btn} rounded-[10px] px-4 py-2.5 text-sm font-semibold`} style={{ background: C.blue }}>{t('common.cancel')}</button>
        <button type="button" onClick={() => void os.filesResolve(job.id, 'continue', false)} className={`${btn} rounded-[10px] px-4 py-2.5 text-sm`} style={{ border: '1px solid rgba(255,138,122,0.45)', color: '#FFB4A8' }}>{t('files.arc.continue')}</button>
      </div>
    </Modal>
  )
}

interface Node { name: string; path: string; dir: boolean; size: number | null; modified: number | null; link: string | null }
/** The entries directly inside `inner`, with folders that only appear as path prefixes. */
export function childrenOf(entries: ArchiveEntry[], inner: string): Node[] {
  const pre = inner ? `${inner}/` : ''
  const out = new Map<string, Node>()
  for (const e of entries) {
    if (!e.path.startsWith(pre) || e.path === inner) continue
    const rest = e.path.slice(pre.length), seg = rest.split('/')[0]
    if (!seg) continue
    const p = pre + seg, dir = rest.includes('/') || e.type === 'dir'
    const cur = out.get(seg)
    if (!cur) out.set(seg, { name: seg, path: p, dir, size: dir ? null : e.size, modified: rest.includes('/') ? null : e.modified, link: e.type === 'symlink' ? e.link : null })
    else if (dir) { cur.dir = true; cur.size = null; if (!rest.includes('/')) cur.modified = e.modified }
  }
  return [...out.values()].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

/** "Open archive": browse an archive read-only and extract chosen items next to it. */
export function ArchiveView({ root, rel, inner, onGo, onLeave, onExtract, password, setPassword }: {
  root: string; rel: string; inner: string; onGo: (inner: string) => void; onLeave: () => void; onExtract: (items: string[]) => void; password: string | null; setPassword: (pw: string | null) => void
}) {
  const [listing, setListing] = useState<ArchiveListing | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<string[]>([])
  const name = rel.split('/').pop() ?? rel
  useEffect(() => {
    let live = true
    setErr(null)
    void os.filesArchiveList(root, rel, password).then((r) => { if (!live) return; if (r.ok) setListing(r.value); else { setListing(null); setErr(r.error) } })
    return () => { live = false }
  }, [root, rel, password])
  useEffect(() => setSel([]), [inner])
  const nodes = useMemo(() => (listing ? childrenOf(listing.entries, inner) : []), [listing, inner])
  const pick = (n: Node, ev: React.MouseEvent) => setSel((s) => {
    if (ev.shiftKey && s.length) { const a = nodes.findIndex((x) => x.path === s[s.length - 1]), b = nodes.indexOf(n); return nodes.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path) }
    return ev.ctrlKey || ev.metaKey ? (s.includes(n.path) ? s.filter((x) => x !== n.path) : [...s, n.path]) : [n.path]
  })
  if (err === 'password' || err === 'wrong_password') return <PasswordDialog name={name} wrong={err === 'wrong_password'} onCancel={onLeave} onSubmit={setPassword} />
  if (err) return <p role="alert" className="p-6 text-sm" style={{ color: '#FF8A7A' }}>{err === 'failed' ? t('files.arc.cantOpen') : archiveError(err)}</p>
  if (!listing) return <p className="p-6 text-sm" style={{ color: C.muted }}>{t('common.loading')}</p>
  const files = listing.entries.filter((e) => e.type !== 'dir').length
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={(e) => {
      if (e.ctrlKey && e.key === 'a') { e.preventDefault(); setSel(nodes.map((n) => n.path)) }
      else if (e.key === 'Backspace' && inner) { e.preventDefault(); onGo(inner.split('/').slice(0, -1).join('/')) }
    }}>
      <div className="mx-6 mt-4 flex items-center gap-3 rounded-xl px-4 py-3 text-[13px]" style={{ background: 'rgba(31,107,255,0.08)', border: '1px solid rgba(31,107,255,0.3)', color: C.soft }}>
        <Svg d={P.compress} size={18} stroke={C.link} />
        <span className="grow">{t('files.arc.readOnly')}</span>
        <button type="button" disabled={!sel.length} onClick={() => onExtract(sel)} className={`${btn} rounded-lg px-3.5 py-[7px] text-[13px] font-semibold disabled:opacity-40`} style={{ background: C.blue, color: '#FFFFFF' }}>{t('files.arc.extractSel', { count: formatNumber(sel.length) })}</button>
        <button type="button" onClick={() => onExtract([])} className={`${btn} rounded-lg px-3.5 py-[7px] text-[13px]`} style={{ border: '1px solid rgba(127,178,255,0.25)', color: C.text }}>{t('files.arc.extractAll')}</button>
      </div>
      <div role="listbox" aria-multiselectable="true" aria-label={name} className="flex min-w-0 flex-1 flex-col overflow-auto px-3 py-3">
        <div className="grid grid-cols-[minmax(0,1fr)_110px_90px_120px] gap-3 px-3 py-2.5 text-xs" style={{ color: C.muted, borderBottom: '1px solid rgba(127,178,255,0.1)' }}>
          <span>{t('files.col.name')}</span><span>{t('files.col.modified')}</span><span>{t('files.col.size')}</span><span>{t('files.col.kind')}</span>
        </div>
        {nodes.length === 0 && <p className="px-3 py-4 text-sm" style={{ color: C.muted }}>{t('files.arc.empty')}</p>}
        {nodes.map((n, i) => {
          const k = kindOf(n.name, n.dir), on = sel.includes(n.path)
          return (
            <button key={n.path} type="button" role="option" aria-selected={on} onClick={(ev) => pick(n, ev)} onDoubleClick={() => (n.dir ? onGo(n.path) : onExtract([n.path]))}
              onKeyDown={(e) => { if (e.key === 'Enter') { if (n.dir) onGo(n.path); else onExtract([n.path]) } }}
              className={`${btn} grid grid-cols-[minmax(0,1fr)_110px_90px_120px] items-center gap-3 rounded-lg px-3 py-[9px] text-left text-[13px]`}
              style={{ background: on ? 'rgba(31,107,255,0.22)' : i % 2 ? 'rgba(255,255,255,0.015)' : 'transparent' }}>
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-[26px] flex-none items-center justify-center rounded-md font-mono text-[8px] font-bold" style={{ background: k.color }}>{k.ext}</span>
                <span className="truncate" style={{ fontWeight: n.dir ? 600 : 400 }}>{n.name}</span>
                {n.link && <span className="truncate text-xs" style={{ color: C.muted }}>{t('files.arc.link', { target: n.link })}</span>}
              </span>
              <span style={{ color: C.soft }}>{day(n.modified)}</span>
              <span className="font-mono text-xs" style={{ color: C.soft }}>{n.dir ? '—' : formatBytes(n.size)}</span>
              <span className="truncate" style={{ color: C.muted }}>{k.label}</span>
            </button>
          )
        })}
      </div>
      <footer className="box-border flex h-8 shrink-0 items-center justify-between px-5 text-xs" style={{ borderTop: `1px solid ${C.line}`, color: C.muted }}>
        <span>{t('files.arc.summary', { count: formatNumber(files), size: formatBytes(listing.total), packed: formatBytes(listing.packed) })}</span>
        <span>{sel.length ? t('files.selectedOnly', { count: formatNumber(sel.length) }) : stemOf(name)}</span>
      </footer>
    </div>
  )
}
