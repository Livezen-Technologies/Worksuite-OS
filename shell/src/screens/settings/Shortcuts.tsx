// Settings › Keyboard › Shortcuts: every system shortcut by category (lib/shortcuts.ts), with search; a system
// shortcut can get other keys or be turned off, and the person can add shortcuts that open an app or run a command.
// Conflicts (two shortcuts on the same keys) are shown and must be solved before saving. Changes are kept in the synced
// preferences (they follow the person) and written to their Labwc rc.xml (electron/shortcutsHost.ts). Also the
// "Use the Print Screen key to open screen snipping" switch (electron/capture.ts).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dialog, Svg, btnGhost, btnPrimary, card, dialogFooter, field, linkBtn, rowLine, sectionLabel } from '../../components/Dk'
import { KeyList, Keys } from '../../components/ShortcutHelp'
import { os } from '../../lib/os'
import { shellPrefsFrom, type ShellPrefs } from '../../lib/shellPrefs'
import { captureApi } from '../../lib/captureApi'
import { CATEGORIES, SYSTEM_SHORTCUTS, bindable, categoryLabel, conflicts, effectiveKeys, keyCaps, keyFromEvent, normalizeKey, reserved, shortcutLabel, usedBy, MAX_CUSTOM, type Binding, type CustomShortcut, type ShortcutPrefs, type SystemShortcut } from '../../lib/shortcuts'
import { t, type MessageKey } from '../../i18n'
import { BigSwitch, Note } from './ui'

type Owner = Binding['owner']
const ownerName = (o: Owner, p: ShortcutPrefs | undefined) => o.kind === 'system' ? t(shortcutLabel(o.id)) : p?.custom?.find((c) => c.id === o.id)?.name || t('sc.customUnnamed')

/** Loads and saves the synced preferences; `apply` writes rc.xml. */
function useShortcutPrefs(initial?: ShortcutPrefs) {
  const [prefs, setPrefs] = useState<ShortcutPrefs | undefined>(initial)
  const [all, setAll] = useState<ShellPrefs>({})
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    if (initial) return
    void os.shellPrefs().then((r) => { if (r.ok) { const p = shellPrefsFrom(r.value); setAll(p); setPrefs(p.shortcuts) } }).catch(() => {})
  }, [initial])
  const save = async (next: ShortcutPrefs | undefined) => {
    const clean = next && (next.keys && Object.keys(next.keys).length || next.custom?.length) ? { ...(next.keys && Object.keys(next.keys).length ? { keys: next.keys } : {}), ...(next.custom?.length ? { custom: next.custom } : {}) } : undefined
    setPrefs(clean)
    const merged = { ...all, shortcuts: clean }
    setAll(merged)
    void os.setShellPrefs(merged).catch(() => undefined)
    const r = await captureApi?.shortcutsApply(clean)
    setStatus(!r ? { tone: 'ok', text: t('sc.savedPreview') } : r.available ? { tone: 'ok', text: t('sc.saved') } : { tone: 'error', text: t('sc.saveFailed') })
  }
  return { prefs, save, status }
}

export function ShortcutsPanel({ initial }: { initial?: ShortcutPrefs }) {
  const { prefs, save, status } = useShortcutPrefs(initial)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<{ kind: 'system'; s: SystemShortcut } | { kind: 'custom'; c: CustomShortcut | null } | null>(null)
  const [printSnip, setPrintSnip] = useState<boolean | null>(null)
  useEffect(() => { void captureApi?.settings().then((s) => setPrintSnip(s.printOpensSnip)).catch(() => {}) }, [])
  const clash = useMemo(() => conflicts(prefs), [prefs])
  const clashOf = (o: Owner) => [...clash.values()].find((list) => list.some((x) => x.kind === o.kind && x.id === o.id))?.filter((x) => !(x.kind === o.kind && x.id === o.id)) ?? []
  const s = q.trim().toLowerCase()
  const match = (label: string, keys: string[]) => !s || label.toLowerCase().includes(s) || keys.some((k) => keyCaps(k).join('+').toLowerCase().includes(s))

  const setKey = (id: string, key: string | null) => {
    const keys = { ...(prefs?.keys ?? {}) }
    if (key === null) delete keys[id]; else keys[id] = key
    void save({ ...prefs, keys })
  }
  const custom = prefs?.custom ?? []

  return <>
    <div className={`${card} overflow-hidden`}>
      <div className={`flex min-h-[56px] items-center gap-4 px-5 py-3 ${rowLine}`}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-semibold">{t('sc.printSnip')}</span><span className="text-xs text-[#8FA3C8]">{t('sc.printSnipSub')}</span></span>
        <BigSwitch label={t('sc.printSnip')} checked={!!printSnip} disabled={printSnip === null} onChange={(v) => { setPrintSnip(v); void captureApi?.setSettings({ printOpensSnip: v }) }} />
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex min-w-[240px] flex-1 items-center gap-2">
        <span className="sr-only">{t('sc.search')}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sc.search')} aria-label={t('sc.search')} className={`${field} w-full`} />
      </label>
      <button type="button" className={`${btnPrimary} gap-2`} disabled={custom.length >= MAX_CUSTOM} onClick={() => setEditing({ kind: 'custom', c: null })}>
        <Svg d="M12 5v14M5 12h14" size={16} stroke="#FFFFFF" />{t('sc.add')}
      </button>
    </div>
    {status && <p role="status" className="m-0 text-[13px]" style={{ color: status.tone === 'ok' ? 'var(--ws-g-green)' : 'var(--ws-g-red)' }}>{status.text}</p>}
    {clash.size > 0 && (
      <div role="alert" className="flex flex-col gap-1 rounded-xl border border-[rgba(183,121,31,0.45)] bg-[rgba(183,121,31,0.12)] px-4 py-3 text-[13px] text-[#F5D29A]">
        <span className="font-semibold">{t('sc.conflictsTitle')}</span>
        {[...clash.entries()].map(([k, owners]) => <span key={k} className="flex flex-wrap items-center gap-2"><Keys k={k} small />{owners.map((o) => ownerName(o, prefs)).join(' · ')}</span>)}
      </div>
    )}

    {(custom.length > 0 || !s) && (
      <Section title={t('sc.customTitle')}>
        {custom.filter((c) => match(c.name, [c.key])).map((c) => {
          const other = clashOf({ kind: 'custom', id: c.id })
          return (
            <Line key={c.id} label={c.name || t('sc.customUnnamed')} sub={c.app ? t('sc.opensApp', { app: c.app }) : t('sc.runs', { command: c.command ?? '' })} keys={[c.key]} conflict={other.map((o) => ownerName(o, prefs))}>
              <button type="button" className={linkBtn} onClick={() => setEditing({ kind: 'custom', c })}>{t('sc.edit')}</button>
              <button type="button" className={linkBtn} aria-label={t('sc.removeNamed', { name: c.name })} onClick={() => void save({ ...prefs, custom: custom.filter((x) => x.id !== c.id) })}>{t('sc.remove')}</button>
            </Line>
          )
        })}
        {!custom.length && <p className="m-0 px-5 py-3.5 text-[13px] text-[#8FA3C8]">{t('sc.customEmpty')}</p>}
      </Section>
    )}

    {CATEGORIES.map((cat) => {
      const rows = SYSTEM_SHORTCUTS.filter((x) => x.category === cat).filter((x) => match(t(shortcutLabel(x.id)), x.display ? [x.display] : effectiveKeys(x, prefs)))
      if (!rows.length) return null
      return (
        <Section key={cat} title={t(categoryLabel(cat))}>
          {rows.map((x) => {
            const keys = x.display ? [x.display] : effectiveKeys(x, prefs)
            const changed = prefs?.keys?.[x.id] !== undefined
            const other = clashOf({ kind: 'system', id: x.id })
            return (
              <Line key={x.id} label={t(shortcutLabel(x.id))} keys={keys} off={!keys.length} changed={changed} conflict={other.map((o) => ownerName(o, prefs))}
                sub={!x.editable ? (x.action || x.display ? t('sc.fixed') : t('sc.byApps')) : undefined}>
                {x.editable && <>
                  <button type="button" className={linkBtn} aria-label={t('sc.changeNamed', { name: t(shortcutLabel(x.id)) })} onClick={() => setEditing({ kind: 'system', s: x })}>{t('sc.changeOne')}</button>
                  {keys.length > 0 && <button type="button" className={linkBtn} aria-label={t('sc.turnOffNamed', { name: t(shortcutLabel(x.id)) })} onClick={() => setKey(x.id, '')}>{t('sc.turnOff')}</button>}
                  {changed && <button type="button" className={linkBtn} aria-label={t('sc.resetNamed', { name: t(shortcutLabel(x.id)) })} onClick={() => setKey(x.id, null)}>{t('sc.reset')}</button>}
                </>}
              </Line>
            )
          })}
        </Section>
      )
    })}
    <Note>{t('sc.note')}</Note>

    {editing?.kind === 'system' && (
      <KeyDialog title={t('sc.changeTitle', { name: t(shortcutLabel(editing.s.id)) })} prefs={prefs} self={{ kind: 'system', id: editing.s.id }} initialKey={effectiveKeys(editing.s, prefs)[0] ?? ''}
        onClose={() => setEditing(null)} onSave={(key) => { setEditing(null); setKey(editing.s.id, normalizeKey(key) === normalizeKey(editing.s.keys[0]) ? null : key) }} />
    )}
    {editing?.kind === 'custom' && (
      <KeyDialog title={editing.c ? t('sc.editTitle') : t('sc.addTitle')} prefs={prefs} self={editing.c ? { kind: 'custom', id: editing.c.id } : undefined} initialKey={editing.c?.key ?? ''} custom={editing.c ?? { id: '', name: '', key: '' }}
        onClose={() => setEditing(null)} onSave={(key, c) => {
          setEditing(null)
          if (!c) return
          const item: CustomShortcut = { ...c, key, id: c.id || `c${Date.now().toString(36)}` }
          void save({ ...prefs, custom: editing.c ? custom.map((x) => (x.id === item.id ? item : x)) : [...custom, item] })
        }} />
    )}
  </>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className={`m-0 font-normal ${sectionLabel}`}>{title}</h2>
      <div className={`${card} overflow-hidden`}>{children}</div>
    </section>
  )
}

function Line({ label, sub, keys, off, changed, conflict, children }: { label: string; sub?: string; keys: string[]; off?: boolean; changed?: boolean; conflict: string[]; children?: ReactNode }) {
  return (
    <div className={`flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-2.5 ${rowLine}`}>
      <span className="flex min-w-[180px] flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}{changed && <span className="ms-2 rounded-full bg-[rgba(24,212,240,0.15)] px-2 py-0.5 text-[11px] font-normal text-[#18D4F0]">{t('sc.changed')}</span>}</span>
        {sub && <span className="truncate text-xs text-[#8FA3C8]">{sub}</span>}
        {conflict.length > 0 && <span className="flex items-center gap-1 text-xs text-[#F5B83D]"><Svg d="M12 3l9 16H3zM12 10v4M12 17h.01" size={13} />{t('sc.alsoUsedBy', { names: conflict.join(', ') })}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-2">{off ? <span className="text-[13px] text-[#8FA3C8]">{t('common.off')}</span> : <KeyList keys={keys} />}</span>
      {children && <span className="flex items-center gap-3">{children}</span>}
    </div>
  )
}

/** "Press the new shortcut": records one key combination; for a custom shortcut also its name and what it runs. */
function KeyDialog({ title, prefs, self, initialKey, custom, onClose, onSave }: {
  title: string; prefs: ShortcutPrefs | undefined; self?: Owner; initialKey: string; custom?: CustomShortcut; onClose: () => void; onSave: (key: string, c?: CustomShortcut) => void
}) {
  const [key, setKey] = useState(initialKey)
  const [c, setC] = useState<CustomShortcut | undefined>(custom)
  const [runKind, setRunKind] = useState<'app' | 'command'>(custom?.command ? 'command' : 'app')
  const [apps, setApps] = useState<{ id: string; name: string }[]>([])
  const [recording, setRecording] = useState(!initialKey)
  useEffect(() => { if (custom) void os.installedApps().then((r) => setApps((r.apps ?? []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {}) }, [custom])
  const users = key ? usedBy(prefs, key, self) : []
  const problem = !key ? null : reserved(key) ? t('sc.reserved') : !bindable(key) ? t('sc.needsModifier') : users.length ? t('sc.inUse', { names: users.map((o) => ownerName(o, prefs)).join(', ') }) : null
  const runOk = !c || (runKind === 'app' ? !!c.app : !!c.command?.trim())
  const ok = !!key && !problem && runOk && (!c || !!c.name.trim())
  const record = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' || (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey)) return
    e.preventDefault(); e.stopPropagation()
    const k = keyFromEvent(e.nativeEvent)
    if (k) { setKey(k); setRecording(false) }
  }
  return (
    <Dialog width={480} onClose={onClose}>
      {(id) => <>
        <div className="flex flex-col gap-4 px-6 pt-5 pb-5">
          <h2 id={id} className="m-0 text-lg font-semibold">{title}</h2>
          {c && <>
            <label className="flex flex-col gap-1.5 text-[13px]">{t('sc.name')}
              <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value.slice(0, 80) })} className={field} data-autofocus />
            </label>
            <div role="radiogroup" aria-label={t('sc.runsLabel')} className="flex gap-4 text-[13px]">
              <label className="flex items-center gap-2"><input type="radio" name="run" checked={runKind === 'app'} onChange={() => { setRunKind('app'); setC({ ...c, command: undefined }) }} className="accent-[#1F6BFF]" />{t('sc.runApp')}</label>
              <label className="flex items-center gap-2"><input type="radio" name="run" checked={runKind === 'command'} onChange={() => { setRunKind('command'); setC({ ...c, app: undefined }) }} className="accent-[#1F6BFF]" />{t('sc.runCommand')}</label>
            </div>
            {runKind === 'app' ? (
              <select value={c.app ?? ''} onChange={(e) => setC({ ...c, app: e.target.value || undefined, name: c.name || apps.find((a) => a.id === e.target.value)?.name || '' })} aria-label={t('sc.runApp')} className={field}>
                <option value="">{t('sc.pickApp')}</option>
                {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            ) : (
              <input value={c.command ?? ''} onChange={(e) => setC({ ...c, command: e.target.value.slice(0, 500) })} aria-label={t('sc.runCommand')} placeholder={t('sc.commandPlaceholder')} className={`${field} font-mono`} />
            )}
          </>}
          <div className="flex flex-col gap-1.5 text-[13px]">
            <span id={`${id}-keys`}>{t('sc.keys')}</span>
            <button type="button" aria-labelledby={`${id}-keys`} aria-describedby={`${id}-keyhint`} onKeyDown={record} onClick={() => setRecording(true)} onFocus={() => setRecording(true)} onBlur={() => setRecording(false)}
              className={`flex min-h-[52px] cursor-pointer items-center justify-center rounded-xl border-2 border-dashed px-3 ${recording ? 'border-[#1F6BFF] bg-[rgba(31,107,255,0.1)]' : 'border-[rgba(127,178,255,0.3)]'}`}>
              {key ? <Keys k={key} /> : <span className="text-[#8FA3C8]">{t('sc.pressKeys')}</span>}
            </button>
            <span id={`${id}-keyhint`} className="text-xs text-[#8FA3C8]">{recording ? t('sc.recording') : t('sc.clickToRecord')}</span>
            {problem && <span role="alert" className="text-xs text-[#F5B83D]">{problem}</span>}
          </div>
        </div>
        <div className={dialogFooter}>
          <button type="button" className={btnGhost} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className={btnPrimary} disabled={!ok} onClick={() => onSave(key, c)}>{t('sc.save')}</button>
        </div>
      </>}
    </Dialog>
  )
}

export const shortcutCategoryKey = (c: string) => `sc.cat.${c}` as MessageKey
