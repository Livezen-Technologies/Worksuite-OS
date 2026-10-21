// `?mode=taskbar&output=NAME`: the taskbar's own window on that output, above the app windows (#53,
// electron/taskbar.ts). It draws the taskbar its shell window publishes and hands the clicks back (lib/taskbarMirror.ts).
import { useEffect, useRef } from 'react'
import { applyMirroredStyles, controlLabel, nodePath, taskbarApi, type TaskbarApi, type TaskbarEvent } from '../lib/taskbarMirror'

export default function TaskbarWindow({ api = taskbarApi() }: { api?: TaskbarApi | null }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    for (const el of [document.documentElement, document.body]) { el.style.background = 'transparent'; el.style.overflow = 'hidden' }
    const host = box.current
    if (!api || !host) return
    const offHtml = api.onHtml((p) => {
      const { html, attrs } = (p ?? {}) as { html?: unknown; attrs?: unknown }
      if (typeof html !== 'string') return
      host.innerHTML = html
      applyMirroredStyles(host)
      // No focus or keyboard path into a copy: the shell window's taskbar has those.
      for (const el of host.querySelectorAll<HTMLElement>('[id]')) el.removeAttribute('id')
      if (attrs && typeof attrs === 'object') {
        for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
          if (typeof v !== 'string') continue
          if (k === 'style') document.documentElement.style.cssText = v   // CSSOM: allowed by the shell's CSP
          else if (/^(class|data-touch|data-theme|lang|dir)$/.test(k)) document.documentElement.setAttribute(k, v)
        }
        if (!('data-touch' in attrs)) document.documentElement.removeAttribute('data-touch')
      }
      document.documentElement.style.background = 'transparent'
    })
    const send = (kind: TaskbarEvent['kind'], ev: Event, extra: Partial<TaskbarEvent> = {}) => {
      const root = host.firstElementChild
      const target = ev.target instanceof Element ? ev.target : null
      const path = root && target ? nodePath(root, target) : null
      if (!path) return
      ev.preventDefault()
      void api.event({ kind, path, label: controlLabel(target), ...extra }).catch(() => undefined)
    }
    const click = (e: MouseEvent) => send('click', e)
    const menu = (e: MouseEvent) => send('contextmenu', e)
    const aux = (e: MouseEvent) => { if (e.button === 1) send('auxclick', e) }
    const wheel = (e: WheelEvent) => send('wheel', e, { dx: e.deltaX, dy: e.deltaY })
    host.addEventListener('click', click)
    host.addEventListener('contextmenu', menu)
    host.addEventListener('auxclick', aux)
    host.addEventListener('wheel', wheel, { passive: false })
    void api.hello().catch(() => undefined)
    return () => { offHtml(); host.removeEventListener('click', click); host.removeEventListener('contextmenu', menu); host.removeEventListener('auxclick', aux); host.removeEventListener('wheel', wheel) }
  }, [api])
  return <div ref={box} data-testid="taskbar-window" className="relative h-screen w-screen overflow-hidden font-sans" />
}
