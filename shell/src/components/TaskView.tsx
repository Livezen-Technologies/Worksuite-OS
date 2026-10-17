// Task View and desktops, like Windows 11 (WSOS-DSK-003). Super+Tab, the taskbar's Task View button or a three-finger
// swipe up open it over everything: the desktop's open windows as cards (app icon and title; Labwc 0.8 can't capture a
// single window, see native/wayland-bridge/worksuite_bridge/capture.py), and a strip of desktops at the bottom with
// "New desktop". Windows can be dragged onto a desktop; desktops can be dragged to reorder, renamed (double-click the
// name), given a background, moved and closed from their menu. Everything works from the keyboard.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { panel, type PanelWindow, type Workspaces } from '../lib/panel'
import { MAX_DESKTOPS, cleanName, desktopName, isSticky, isStickyApp, windowsOn } from '../lib/desktops'
import { WALLPAPERS } from '../lib/displays'
import { AppGlyph, type GlyphApp } from './AppGlyph'
import { Icon, P } from './Ws'
import { useT } from '../i18n'

export type AppLookup = (appId: string) => GlyphApp & { name: string }
const DRAG_WINDOW = 'application/x-worksuite-window'
const DRAG_DESKTOP = 'application/x-worksuite-desktop'
const PLUS = ['M12 5v14', 'M5 12h14']

interface Props {
  ws: Workspaces
  windows: PanelWindow[]
  info: AppLookup
  /** Desktop n's own wallpaper (CSS), else the display's. */
  wallpaper: (n: number) => string
  /** A low-resolution capture of the screen as Task View opened (the current desktop), or null. */
  capture: string | null
  /** picked: a window or desktop was chosen (otherwise focus goes back to the window that had it). */
  onClose: (picked: boolean) => void
  onBackground: (n: number, id: string) => void
}

type Menu = { kind: 'window'; w: PanelWindow; x: number; y: number } | { kind: 'desktop'; n: number; x: number; y: number }

export default function TaskView({ ws, windows, info, wallpaper, capture, onClose, onBackground }: Props) {
  const t = useT()
  const [preview, setPreview] = useState<number | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [bgFor, setBgFor] = useState<number | null>(null)
  const [dropOn, setDropOn] = useState<number | 'new' | null>(null)
  const shown = preview ?? ws.current
  const list = useMemo(() => windowsOn(windows, ws, shown), [windows, ws, shown])
  const grid = useRef<HTMLDivElement>(null)
  const dynamic = !!ws.dynamic

  useEffect(() => { void panel.taskViewState?.(true); return () => { void panel.taskViewState?.(false) } }, [])
  // Focus the first window card (or the current desktop's card when there are none).
  useEffect(() => {
    const first = grid.current?.querySelector<HTMLElement>('[data-window]') ?? document.querySelector<HTMLElement>(`[data-desktop="${ws.current}"]`)
    first?.focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (menu) setMenu(null)
      else if (bgFor !== null) setBgFor(null)
      else if (renaming !== null) setRenaming(null)
      else onClose(false)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [menu, bgFor, renaming, onClose])

  const pickWindow = (w: PanelWindow) => { void panel.activate(w.handle); onClose(true) }
  const goDesktop = (n: number) => { if (n !== ws.current) void panel.activateWorkspace?.(n); onClose(true) }
  const moveWindow = async (handle: string, n: number | 'new') => {
    if (n === 'new') {
      if (ws.count >= MAX_DESKTOPS || !dynamic) return
      await panel.createWorkspace?.()
      n = ws.count + 1
    }
    await panel.moveToWorkspace?.(handle, n)
  }
  const newDesktop = () => { if (dynamic && ws.count < MAX_DESKTOPS) void panel.createWorkspace?.() }
  const moveDesktop = (n: number, to: number) => { if (dynamic && to >= 1 && to <= ws.count && to !== n) void panel.moveWorkspace?.(n, to) }
  const closeDesktop = (n: number) => { if (dynamic && ws.count > 1) void panel.removeWorkspace?.(n) }

  // Arrow keys move between the window cards (grid order); Delete closes one; the menu key or Shift+F10 opens its menu.
  const gridKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-window]')]
    const i = cards.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    const cols = Math.max(1, Math.round(e.currentTarget.clientWidth / Math.max(1, cards[0].offsetWidth + 16)) || 1)
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: cards.length - 1 - i }[e.key]
    if (step !== undefined) { e.preventDefault(); cards[Math.max(0, Math.min(cards.length - 1, i + step))]?.focus(); return }
    const w = list[i]
    if (e.key === 'Delete') { e.preventDefault(); void panel.close(w.handle) }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = cards[i].getBoundingClientRect(); setMenu({ kind: 'window', w, x: r.left + 24, y: r.top + 40 }) }
  }
  const stripKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-desktop]')]
    const i = cards.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    const n = Number(cards[i].dataset.desktop)
    if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const to = n + (e.key === 'ArrowLeft' ? -1 : 1) * (document.dir === 'rtl' ? -1 : 1)
      moveDesktop(n, to)
      return
    }
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? cards.length - 1 : null
    if (next !== null) { e.preventDefault(); cards[(next + cards.length) % cards.length]?.focus(); return }
    if (!n) return
    if (e.key === 'F2') { e.preventDefault(); if (dynamic) setRenaming(n) }
    if (e.key === 'Delete') { e.preventDefault(); closeDesktop(n) }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = cards[i].getBoundingClientRect(); setMenu({ kind: 'desktop', n, x: r.left, y: r.top - 8 }) }
  }

  // Pointer drag as well as HTML5 drag and drop: when the native drag starts, Chromium cancels the pointer stream
  // (pointercancel) and the drop handlers below move the window; when it never starts (it did not with some pointer
  // devices under Wayland), the release over a desktop card moves it here.
  const pointerDrag = (e: { button: number; clientX: number; clientY: number }, handle: string) => {
    if (e.button !== 0 || !(dynamic || ws.count > 1)) return
    const x0 = e.clientX, y0 = e.clientY
    let moved = false
    const over = (x: number, y: number): number | 'new' | null => {
      const el = (document.elementFromPoint?.(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-desktop]')
      if (!el) return null
      const n = Number(el.dataset.desktop)
      return n > 0 ? n : 'new'
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel) }
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return
      moved = true
      setDropOn(over(ev.clientX, ev.clientY))
    }
    const up = (ev: PointerEvent) => {
      stop()
      if (!moved) return
      setDropOn(null)
      const target = over(ev.clientX, ev.clientY)
      if (target !== null) void moveWindow(handle, target)
    }
    const cancel = () => { stop(); if (moved) setDropOn(null) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const dropProps = (target: number | 'new') => ({
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_WINDOW) || (target !== 'new' && e.dataTransfer.types.includes(DRAG_DESKTOP))) { e.preventDefault(); setDropOn(target) }
    },
    onDragLeave: () => setDropOn((d) => (d === target ? null : d)),
    onDrop: (e: DragEvent) => {
      e.preventDefault(); setDropOn(null)
      const h = e.dataTransfer.getData(DRAG_WINDOW)
      if (h) { void moveWindow(h, target); return }
      const from = Number(e.dataTransfer.getData(DRAG_DESKTOP))
      if (from && target !== 'new') moveDesktop(from, target)
    },
  })

  const name = (n: number) => desktopName(ws, n)
  return (
    <div id="ws-taskview" role="dialog" aria-modal="true" aria-label={t('desktops.taskView')}
      className="ws-fade fixed inset-0 z-[60] flex flex-col bg-[rgba(2,6,16,0.72)] text-[#E8EEFA] backdrop-blur-[18px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(false) }}>
      <h2 className="sr-only">{t('desktops.taskView')}</h2>
      <p className="m-0 px-8 pt-6 text-[13px] text-[#8FA3C8]">{t('desktops.hint')}</p>
      {/* Windows of the desktop being shown (the current one, or the one under the pointer in the strip). */}
      <section aria-label={t('desktops.windowsOn', { name: name(shown) })} className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-8 py-6"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(false) }}>
        {list.length ? (
          <div ref={grid} role="list" onKeyDown={gridKeys} className="grid w-full max-w-[1200px] grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {list.map((w) => {
              const app = info(w.appId)
              const sticky = isSticky(ws, w) || isStickyApp(ws, w)
              return (
                <div key={w.handle} role="listitem" className="group relative">
                  <button type="button" data-window={w.handle} draggable={dynamic || ws.count > 1}
                    onDragStart={(e) => { e.dataTransfer.setData(DRAG_WINDOW, w.handle); e.dataTransfer.effectAllowed = 'move' }}
                    onPointerDown={(e) => pointerDrag(e, w.handle)}
                    onClick={() => pickWindow(w)}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'window', w, x: e.clientX, y: e.clientY }) }}
                    aria-label={`${w.title || app.name}, ${app.name}${sticky ? `, ${t('desktops.onAll')}` : ''}`}
                    aria-haspopup="menu"
                    className="flex w-full cursor-pointer flex-col overflow-hidden rounded-[14px] border border-[rgba(127,178,255,0.22)] bg-[rgba(16,36,79,0.92)] text-left shadow-[0_18px_40px_rgba(0,0,0,0.45)] hover:border-[#7FB2FF] focus-visible:border-[#7FB2FF]">
                    <span className="flex items-center gap-2 border-b border-[rgba(127,178,255,0.12)] px-3 py-2">
                      <AppGlyph app={{ ...app, id: app.id || w.appId }} size={20} radius={5} font={9} css />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{w.title || app.name}</span>
                      {sticky && <Icon d={['M12 3v18', 'M3 12h18']} size={12} stroke="#18D4F0" />}
                    </span>
                    <span aria-hidden="true" className="flex aspect-[16/10] items-center justify-center bg-[rgba(4,10,26,0.45)]">
                      <AppGlyph app={{ ...app, id: app.id || w.appId }} size={64} radius={16} font={22} css />
                    </span>
                  </button>
                  <button type="button" aria-label={t('desktops.closeWindow', { title: w.title || app.name })} onClick={() => void panel.close(w.handle)}
                    className="absolute top-1.5 right-1.5 flex size-7 cursor-pointer items-center justify-center rounded-lg bg-[#C42B1C] text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                    <Icon d={P.close} size={14} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : <p className="m-0 text-sm text-[#8FA3C8]">{t('desktops.noWindows')}</p>}
      </section>

      {/* Desktops strip */}
      <nav aria-label={t('desktops.strip')} className="flex justify-center px-6 pb-6">
        <div role="toolbar" aria-label={t('desktops.strip')} onKeyDown={stripKeys} onMouseLeave={() => setPreview(null)}
          className="flex max-w-full items-end gap-3 overflow-x-auto rounded-[18px] bg-[rgba(10,24,56,0.85)] p-3">
          {Array.from({ length: ws.count }, (_, i) => i + 1).map((n) => {
            const on = windowsOn(windows, ws, n)
            const current = n === ws.current
            return (
              <div key={ws.ids?.[n - 1] ?? n} className="group relative flex w-[176px] shrink-0 flex-col gap-1.5" {...dropProps(n)}>
                <button type="button" data-desktop={n} draggable={dynamic}
                  onDragStart={(e) => { e.dataTransfer.setData(DRAG_DESKTOP, String(n)); e.dataTransfer.effectAllowed = 'move' }}
                  onMouseEnter={() => setPreview(n)} onFocus={() => setPreview(n)}
                  onClick={() => goDesktop(n)}
                  onContextMenu={(e) => { if (!dynamic) return; e.preventDefault(); setMenu({ kind: 'desktop', n, x: e.clientX, y: e.clientY }) }}
                  aria-current={current ? 'true' : undefined} aria-haspopup={dynamic ? 'menu' : undefined}
                  aria-label={t(current ? 'desktops.cardCurrent' : 'desktops.card', { name: name(n), count: on.length })}
                  className={`relative block h-[99px] w-full cursor-pointer overflow-hidden rounded-xl border-2 ${dropOn === n ? 'border-[#18D4F0]' : current ? 'border-[#1F6BFF]' : 'border-transparent hover:border-[rgba(127,178,255,0.5)]'}`}
                  style={{ background: wallpaper(n) }}>
                  {current && capture
                    ? <img src={capture} alt={t('desktops.screen', { name: name(n) })} className="absolute inset-0 size-full object-cover" />
                    : (
                      <span aria-hidden="true" className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1">
                        {on.slice(0, 6).map((w) => { const a = info(w.appId); return <AppGlyph key={w.handle} app={{ ...a, id: a.id || w.appId }} size={22} radius={6} font={9} css /> })}
                      </span>
                    )}
                </button>
                {renaming === n ? (
                  <RenameField initial={ws.names?.[n - 1] ?? ''} placeholder={name(n)} label={t('desktops.renameLabel')}
                    onDone={(v) => { setRenaming(null); if (v !== null) void panel.renameWorkspace?.(n, cleanName(v)) }} />
                ) : (
                  <span onDoubleClick={() => dynamic && setRenaming(n)} className="truncate px-1 text-center text-[13px]" title={name(n)}>{name(n)}</span>
                )}
                {dynamic && ws.count > 1 && (
                  <button type="button" aria-label={`${t('desktops.close')} ${name(n)}`} onClick={() => closeDesktop(n)}
                    className="absolute top-1 right-1 flex size-6 cursor-pointer items-center justify-center rounded-md bg-[rgba(4,10,26,0.8)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                    <Icon d={P.close} size={12} />
                  </button>
                )}
              </div>
            )
          })}
          {dynamic && ws.count < MAX_DESKTOPS && (
            <div className="flex w-[132px] shrink-0 flex-col gap-1.5" {...dropProps('new')}>
              <button type="button" data-desktop="0" onClick={newDesktop} aria-label={t('desktops.new')}
                className={`flex h-[99px] w-full cursor-pointer items-center justify-center rounded-xl border-2 border-dashed ${dropOn === 'new' ? 'border-[#18D4F0] bg-white/10' : 'border-[rgba(127,178,255,0.35)] hover:bg-white/[0.06]'}`}>
                <Icon d={PLUS} size={26} />
              </button>
              <span aria-hidden="true" className="px-1 text-center text-[13px]">{t('desktops.new')}</span>
            </div>
          )}
        </div>
      </nav>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label={menu.kind === 'window' ? t('desktops.windowMenu', { title: menu.w.title }) : t('desktops.desktopMenu', { name: name(menu.n) })} onClose={() => setMenu(null)}>
          {menu.kind === 'window' ? (
            <>
              {(ws.count > 1 || dynamic) && <span className="px-3 pt-1.5 pb-1 text-xs text-[#8FA3C8]">{t('desktops.moveTo')}</span>}
              {Array.from({ length: ws.count }, (_, i) => i + 1).filter((n) => n !== (ws.windows[menu.w.handle] ?? ws.current)).map((n) => (
                <MenuItem key={n} onClick={() => { void moveWindow(menu.w.handle, n); setMenu(null) }}>{name(n)}</MenuItem>
              ))}
              {dynamic && ws.count < MAX_DESKTOPS && <MenuItem onClick={() => { void moveWindow(menu.w.handle, 'new'); setMenu(null) }}>{t('desktops.new')}</MenuItem>}
              {dynamic && <>
                <Sep />
                <MenuItem checked={isSticky(ws, menu.w)} onClick={() => { void panel.setWindowOnAllDesktops?.(menu.w.handle, !isSticky(ws, menu.w)); setMenu(null) }}>{t('desktops.showWindowAll')}</MenuItem>
                <MenuItem checked={isStickyApp(ws, menu.w)} onClick={() => { void panel.setAppOnAllDesktops?.(menu.w.appId, !isStickyApp(ws, menu.w)); setMenu(null) }}>{t('desktops.showAppAll')}</MenuItem>
              </>}
              <Sep />
              <MenuItem onClick={() => { void panel.close(menu.w.handle); setMenu(null) }}>{t('desktops.close')}</MenuItem>
            </>
          ) : (
            <>
              <MenuItem onClick={() => { setRenaming(menu.n); setMenu(null) }}>{t('desktops.rename')}</MenuItem>
              <MenuItem onClick={() => { setBgFor(menu.n); setMenu(null) }}>{t('desktops.chooseBackground')}</MenuItem>
              <Sep />
              <MenuItem disabled={menu.n <= 1} onClick={() => { moveDesktop(menu.n, menu.n - 1); setMenu(null) }}>{t('desktops.moveLeft')}</MenuItem>
              <MenuItem disabled={menu.n >= ws.count} onClick={() => { moveDesktop(menu.n, menu.n + 1); setMenu(null) }}>{t('desktops.moveRight')}</MenuItem>
              <Sep />
              <MenuItem disabled={ws.count <= 1} onClick={() => { closeDesktop(menu.n); setMenu(null) }}>{t('desktops.close')}</MenuItem>
            </>
          )}
        </ContextMenu>
      )}
      {bgFor !== null && <BackgroundPicker title={t('desktops.backgroundTitle', { name: name(bgFor) })} onPick={(id) => { onBackground(bgFor, id); setBgFor(null) }} onClose={() => setBgFor(null)} />}
    </div>
  )
}

function RenameField({ initial, placeholder, label, onDone }: { initial: string; placeholder: string; label: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial)
  const done = useRef(false)
  const finish = (x: string | null) => { if (done.current) return; done.current = true; onDone(x) }
  return (
    <input autoFocus aria-label={label} value={v} maxLength={40} placeholder={placeholder} onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()} onBlur={() => finish(v)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(v) } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null) } }}
      className="h-7 w-full rounded-md border border-[#1F6BFF] bg-[rgba(4,10,26,0.8)] px-2 text-center text-[13px] text-[#E8EEFA]" />
  )
}

export function ContextMenu({ x, y, label, onClose, children }: { x: number; y: number; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role^=menuitem]:not([disabled])')?.focus() }, [])
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^=menuitem]:not([disabled])')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
    if (next !== null) { e.preventDefault(); items[(next + items.length) % items.length]?.focus() }
    if (e.key === 'Tab') { e.preventDefault(); onClose() }
  }
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280, h = typeof window !== 'undefined' ? window.innerHeight : 800
  return (
    <>
      <div className="fixed inset-0 z-[70]" aria-hidden="true" onMouseDown={onClose} />
      <div ref={ref} role="menu" aria-label={label} onKeyDown={keys}
        className="fixed z-[71] flex min-w-[240px] flex-col rounded-xl border border-[rgba(127,178,255,0.2)] bg-[#10244F] p-1 text-[13px] text-[#E8EEFA] shadow-[0_18px_40px_rgba(0,0,0,0.5)]"
        style={{ left: Math.max(8, Math.min(x, w - 300)), top: Math.max(8, Math.min(y, h - 360)) }}>
        {children}
      </div>
    </>
  )
}

function MenuItem({ children, onClick, disabled, checked }: { children: ReactNode; onClick: () => void; disabled?: boolean; checked?: boolean }) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} disabled={disabled} onClick={onClick}
      className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10 focus-visible:bg-white/10 disabled:cursor-default disabled:opacity-40">
      {checked !== undefined && <span aria-hidden="true" className="w-4">{checked && <Icon d={['M5 12l5 5 9-10']} size={14} />}</span>}
      {children}
    </button>
  )
}
const Sep = () => <span role="separator" className="my-1 h-px bg-[rgba(127,178,255,0.15)]" />

function BackgroundPicker({ title, onPick, onClose }: { title: string; onPick: (id: string) => void; onClose: () => void }) {
  const t = useT()
  return (
    <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex flex-col gap-3 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[#10244F] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        <div role="group" aria-label={title} className="grid grid-cols-3 gap-3">
          <button type="button" autoFocus onClick={() => onPick('')} className="flex h-[72px] w-[120px] cursor-pointer items-center justify-center rounded-lg border border-dashed border-[rgba(127,178,255,0.4)] px-2 text-center text-xs">{t('desktops.backgroundMonitor')}</button>
          {Object.entries(WALLPAPERS).map(([id, w]) => (
            <button key={id} type="button" aria-label={w.label} title={w.label} onClick={() => onPick(id)} className="h-[72px] w-[120px] cursor-pointer rounded-lg border-2 border-transparent hover:border-[#7FB2FF]" style={{ background: w.css }} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Hover flyout of the taskbar's Task View button: the desktops, small, and "New desktop". */
export function DesktopsFlyout({ ws, windows, info, wallpaper, onLeave }: { ws: Workspaces; windows: PanelWindow[]; info: AppLookup; wallpaper: (n: number) => string; onLeave: () => void }) {
  const t = useT()
  return (
    <div role="group" aria-label={t('desktops.strip')} onMouseLeave={onLeave}
      className="ws-rise absolute bottom-[60px] left-1/2 z-50 flex -translate-x-1/2 gap-2.5 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] p-3 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
      {Array.from({ length: ws.count }, (_, i) => i + 1).map((n) => {
        const on = windowsOn(windows, ws, n)
        return (
          <button key={n} type="button" onClick={() => { void panel.activateWorkspace?.(n); onLeave() }} aria-current={n === ws.current ? 'true' : undefined}
            aria-label={t(n === ws.current ? 'desktops.cardCurrent' : 'desktops.card', { name: desktopName(ws, n), count: on.length })}
            className="flex w-[132px] cursor-pointer flex-col gap-1 rounded-lg p-1 hover:bg-white/[0.06]">
            <span aria-hidden="true" className={`relative block h-[74px] w-full overflow-hidden rounded-lg border-2 ${n === ws.current ? 'border-[#1F6BFF]' : 'border-transparent'}`} style={{ background: wallpaper(n) }}>
              <span className="absolute inset-x-1.5 bottom-1.5 flex flex-wrap gap-1">{on.slice(0, 5).map((w) => { const a = info(w.appId); return <AppGlyph key={w.handle} app={{ ...a, id: a.id || w.appId }} size={18} radius={5} font={8} css /> })}</span>
            </span>
            <span className="truncate text-center text-xs">{desktopName(ws, n)}</span>
          </button>
        )
      })}
      {ws.dynamic && ws.count < MAX_DESKTOPS && (
        <button type="button" onClick={() => void panel.createWorkspace?.()} aria-label={t('desktops.new')} className="flex w-[100px] cursor-pointer flex-col gap-1 rounded-lg p-1 hover:bg-white/[0.06]">
          <span aria-hidden="true" className="flex h-[74px] w-full items-center justify-center rounded-lg border-2 border-dashed border-[rgba(127,178,255,0.35)]"><Icon d={PLUS} size={20} /></span>
          <span aria-hidden="true" className="text-center text-xs">{t('desktops.new')}</span>
        </button>
      )}
    </div>
  )
}

/** The desktop's name, briefly, after a switch (Ctrl+Super+Left/Right, the flyout, Task View). */
export function DesktopToast({ ws }: { ws: Workspaces }) {
  const t = useT()
  const [shown, setShown] = useState<{ n: number; key: number } | null>(null)
  const last = useRef(ws.current)
  useEffect(() => {
    if (ws.current === last.current) return
    last.current = ws.current
    setShown({ n: ws.current, key: Date.now() })
    const id = setTimeout(() => setShown(null), 1400)
    return () => clearTimeout(id)
  }, [ws.current])
  if (!shown || !ws.supported) return null
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center">
      <span key={shown.key} className="ws-desk-toast rounded-2xl border border-[rgba(127,178,255,0.25)] bg-[rgba(10,24,56,0.94)] px-8 py-5 text-[22px] font-semibold text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
        <span className="sr-only">{t('desktops.switched', { name: desktopName(ws, shown.n) })}</span>
        <span aria-hidden="true">{desktopName(ws, shown.n)}</span>
      </span>
    </div>
  )
}
