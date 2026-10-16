// Right-click menu for every text field in the shell (Settings, search, the AI panel, Task View rename, the Snipping
// Tool's text box…): Undo, Cut, Copy, Paste, Delete, Select all, with their keys, like Windows. The commands run in the
// field through the main process (webContents.cut/copy/paste…), so Paste works without clipboard permissions; in the
// browser preview document.execCommand stands in. Shift+F10 or the menu key opens it on the focused field.
// Chromium on Linux has no Ctrl+Y for redo in text fields; it is added here (Ctrl+Shift+Z keeps working).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { captureApi } from '../lib/captureApi'
import { t, useT, type MessageKey } from '../i18n'

type Cmd = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'
const KEYS: Record<Cmd, string> = { undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', delete: 'Del', selectAll: 'Ctrl+A' }
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'password', 'tel', 'number'])

export type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement
export function editableTarget(el: EventTarget | null): Editable | null {
  if (!(el instanceof HTMLElement)) return null
  if (el instanceof HTMLTextAreaElement) return el.disabled ? null : el
  if (el instanceof HTMLInputElement) return !el.disabled && TEXT_TYPES.has(el.type) ? el : null
  const ce = el.closest<HTMLElement>('[contenteditable=""], [contenteditable="true"]')
  return ce
}
/** What the menu offers for this field: cut/copy need a selection (never from a password field), paste a writable field. */
export function menuState(el: Editable): Record<Cmd, boolean> {
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null
  const readOnly = field ? field.readOnly : false
  let selected = false
  try { selected = field ? (field.selectionStart ?? 0) !== (field.selectionEnd ?? 0) : !!window.getSelection()?.toString() } catch { selected = false }
  const secret = field instanceof HTMLInputElement && field.type === 'password'
  const hasText = field ? field.value.length > 0 : !!el.textContent
  return { undo: !readOnly, redo: !readOnly, cut: selected && !readOnly && !secret, copy: selected && !secret, paste: !readOnly, delete: selected && !readOnly, selectAll: hasText }
}

function run(cmd: Cmd, el: Editable) {
  el.focus()
  if (cmd === 'delete') { document.execCommand('delete'); return }
  if (captureApi) { void captureApi.edit(cmd); return }
  if (cmd === 'paste') { void navigator.clipboard?.readText?.().then((s) => document.execCommand('insertText', false, s)).catch(() => undefined); return }
  document.execCommand(cmd)
}

export default function TextContextMenu() {
  useT()
  const [menu, setMenu] = useState<{ x: number; y: number; el: Editable; state: Record<Cmd, boolean> } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const open = (el: Editable, x: number, y: number) => setMenu({ el, x, y, state: menuState(el) })
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const el = editableTarget(e.target)
      if (!el) return
      e.preventDefault()
      open(el, e.clientX, e.clientY)
    }
    const onKey = (e: KeyboardEvent) => {
      const el = editableTarget(e.target)
      if (!el) return
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') { e.preventDefault(); document.execCommand('redo'); return }
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = el.getBoundingClientRect(); open(el, r.left + 12, r.bottom - 4) }
    }
    window.addEventListener('contextmenu', onMenu)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('contextmenu', onMenu); window.removeEventListener('keydown', onKey) }
  }, [])

  useEffect(() => {
    if (!menu) return
    box.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(null) }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('blur', () => setMenu(null), { once: true })
    return () => window.removeEventListener('mousedown', close, true)
  }, [menu])

  if (!menu) return null
  const items: (Cmd | '-')[] = ['undo', 'redo', '-', 'cut', 'copy', 'paste', 'delete', '-', 'selectAll']
  const pick = (c: Cmd) => { const el = menu.el; setMenu(null); run(c, el) }
  const keys = (e: React.KeyboardEvent) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); const el = menu.el; setMenu(null); el.focus() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus() }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); all[e.key === 'Home' ? 0 : all.length - 1]?.focus() }
  }
  const W = 230
  const left = document.dir === 'rtl' ? Math.max(4, Math.min(menu.x - W, window.innerWidth - W - 4)) : Math.max(4, Math.min(menu.x, window.innerWidth - W - 4))
  return createPortal(
    <div ref={box} role="menu" aria-label={t('edit.menu')} onKeyDown={keys} onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[120] flex flex-col rounded-xl border border-[rgba(127,178,255,0.22)] bg-[rgba(10,24,56,0.98)] p-1 font-sans text-[13px] text-[#E8EEFA] shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
      style={{ left, top: Math.max(4, Math.min(menu.y, window.innerHeight - 290)), width: W }}>
      {items.map((c, i) => c === '-' ? <div key={i} role="separator" className="my-1 h-px bg-[rgba(127,178,255,0.15)]" /> : (
        <button key={c} type="button" role="menuitem" aria-disabled={!menu.state[c]} aria-keyshortcuts={KEYS[c].replace('Ctrl', 'Control').replace('Del', 'Delete')} tabIndex={-1}
          onClick={() => { if (menu.state[c]) pick(c) }}
          className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-1.5 text-start hover:bg-white/10 focus-visible:bg-white/10 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent">
          <span>{t(`edit.${c}` as MessageKey)}</span><span className="text-[11px] text-[#8FA3C8]" dir="ltr">{KEYS[c]}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
