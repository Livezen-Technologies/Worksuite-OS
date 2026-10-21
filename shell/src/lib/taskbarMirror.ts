// The taskbar's own window (#53, electron/taskbar.ts) shows the taskbar above the app windows. The shell window of
// that output keeps the real taskbar (all its state: launcher, tray, quick settings, badges, the language switcher…):
// it publishes the taskbar's markup whenever it changes, and the taskbar window draws that markup and hands every
// click, right-click and wheel turn back, by the clicked element's position in the taskbar. The shell window then
// performs it on its own element, so each flyout opens in the shell window, lifted over the apps (popupLift.ts).
import { useEffect, type RefObject } from 'react'

export interface TaskbarEvent { kind: 'click' | 'contextmenu' | 'auxclick' | 'wheel'; path: number[]; label: string; dx?: number; dy?: number }
export interface TaskbarApi {
  publish(output: string, html: string, attrs: Record<string, string>): Promise<unknown>
  wanted(on: boolean): Promise<unknown>
  onEvent(cb: (e: unknown) => void): () => void
  onRepublish(cb: (e: unknown) => void): () => void
  hello(): Promise<unknown>
  event(e: TaskbarEvent): Promise<unknown>
  onHtml(cb: (p: unknown) => void): () => void
}
declare global {
  interface Window { worksuiteTaskbar?: TaskbarApi }
}
export const taskbarApi = (): TaskbarApi | null => (typeof window !== 'undefined' && window.worksuiteTaskbar) || null

/** Child indexes from `root` down to `el` (null when `el` is not inside it). */
export function nodePath(root: Element, el: Element): number[] | null {
  const path: number[] = []
  let n: Element | null = el
  while (n && n !== root) {
    const parent: Element | null = n.parentElement
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.children, n))
    n = parent
  }
  return n === root ? path : null
}
export function resolvePath(root: Element, path: number[]): Element | null {
  let n: Element | null = root
  for (const i of path) { n = n?.children[i] ?? null; if (!n) return null }
  return n
}
/** The name of the control an element belongs to: checks the owner acts on the control that was clicked. */
export function controlLabel(el: Element | null): string {
  const c = el?.closest('button, a, [role="button"], [role="menuitem"], [tabindex]')
  return (c?.getAttribute('aria-label') || c?.getAttribute('title') || c?.textContent || '').trim().slice(0, 200)
}

/** Root attributes the taskbar's look depends on: touch mode (64 px), theme, language and direction. */
const ROOT_ATTRS = ['class', 'data-touch', 'data-theme', 'lang', 'dir', 'style']
export function rootAttrs(doc: Document = document): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of ROOT_ATTRS) { const v = doc.documentElement.getAttribute(a); if (v !== null) out[a] = v }
  return out
}

/** The taskbar's markup with inline styles moved to data-ws-style: the shell's CSP (style-src 'self') drops style
 *  attributes that come in as markup, and the copy sets them again through the CSSOM (applyMirroredStyles). */
export function mirrorMarkup(nav: Element): string {
  const copy = nav.cloneNode(true) as Element
  for (const el of [copy, ...copy.querySelectorAll('[style]')]) {
    const v = el.getAttribute('style')
    if (v === null) continue
    el.setAttribute('data-ws-style', v)
    el.removeAttribute('style')
  }
  return copy.outerHTML
}
export function applyMirroredStyles(root: Element) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-ws-style]')) el.style.cssText = el.getAttribute('data-ws-style') ?? ''
}

/** In the owner: perform an event from the taskbar window on its own taskbar element. */
export function performTaskbarEvent(root: Element, raw: unknown): boolean {
  const e = raw as Partial<TaskbarEvent> | null
  if (!e || !Array.isArray(e.path) || !e.path.every((i) => Number.isInteger(i) && i >= 0) || typeof e.label !== 'string') return false
  let el = resolvePath(root, e.path)
  // The taskbar changed in between: find the control by its name instead.
  if (!el || controlLabel(el) !== e.label) {
    el = [...root.querySelectorAll('button, a, [role="button"], [tabindex]')].find((c) => controlLabel(c) === e.label) ?? null
  }
  if (!el) return false
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  if (e.kind === 'click') {
    // Like a real click: menus that close on a press outside them (the language switcher) see the press first.
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 0 }))
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 0 }))
    el.dispatchEvent(new MouseEvent('click', { ...at, button: 0, detail: 1 }))
  } else if (e.kind === 'contextmenu') {
    el.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2 }))
  } else if (e.kind === 'auxclick') {
    el.dispatchEvent(new MouseEvent('auxclick', { ...at, button: 1 }))
  } else if (e.kind === 'wheel') {
    el.dispatchEvent(new WheelEvent('wheel', { ...at, deltaX: Number(e.dx) || 0, deltaY: Number(e.dy) || 0 }))
  } else return false
  return true
}

/** In the owner (Desktop, OutputDesktop): mirror the taskbar element to the taskbar window and perform its events. */
export function useTaskbarMirror(ref: RefObject<HTMLElement | null>, output: string, api: TaskbarApi | null = taskbarApi()) {
  useEffect(() => {
    const nav = ref.current
    if (!api || !nav) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = ''
    const publish = (force = false) => {
      timer = null
      const html = mirrorMarkup(nav)
      const attrs = rootAttrs()
      const key = html + JSON.stringify(attrs)
      if (!force && key === last) return
      last = key
      void api.publish(output, html, attrs).catch(() => undefined)
    }
    const soon = () => { if (!timer) timer = setTimeout(publish, 40) }
    const mo = new MutationObserver(soon)
    mo.observe(nav, { subtree: true, childList: true, attributes: true, characterData: true })
    const root = new MutationObserver(soon)
    root.observe(document.documentElement, { attributes: true, attributeFilter: ROOT_ATTRS })
    const offEvent = api.onEvent((e) => { performTaskbarEvent(nav, e) })
    const offAgain = api.onRepublish(() => publish(true))
    publish(true)
    return () => { mo.disconnect(); root.disconnect(); offEvent(); offAgain(); if (timer) clearTimeout(timer) }
  }, [ref, output, api])
}
