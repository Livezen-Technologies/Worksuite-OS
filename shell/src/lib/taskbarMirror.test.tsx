// @vitest-environment jsdom
// #53: the taskbar window draws the shell window's taskbar and hands clicks back; the shell window performs them.
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { controlLabel, nodePath, performTaskbarEvent, resolvePath, useTaskbarMirror, type TaskbarApi, type TaskbarEvent } from './taskbarMirror'
import TaskbarWindow from '../screens/TaskbarWindow'

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
let roots: Root[] = []
afterEach(() => { act(() => roots.forEach((r) => r.unmount())); roots = []; document.body.innerHTML = ''; document.documentElement.removeAttribute('data-touch') })
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)) })

/** One fake IPC both sides talk through (electron/main.ts routes it in the real shell). */
function bus() {
  const subs: Record<string, ((p: unknown) => void)[]> = {}
  const on = (ch: string) => (cb: (p: unknown) => void) => { (subs[ch] ??= []).push(cb); return () => { subs[ch] = subs[ch].filter((x) => x !== cb) } }
  const emit = (ch: string, p: unknown) => (subs[ch] ?? []).forEach((cb) => cb(p))
  const published: { output: string; html: string; attrs: Record<string, string> }[] = []
  const api: TaskbarApi = {
    publish: async (output, html, attrs) => { published.push({ output, html, attrs }); emit('html', { html, attrs }) },
    wanted: async () => true,
    onEvent: on('event'), onRepublish: on('again'),
    hello: async () => emit('again', null),
    event: async (e) => emit('event', e),
    onHtml: on('html'),
  }
  return { api, published }
}

function Owner({ api }: { api: TaskbarApi }) {
  const nav = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  useTaskbarMirror(nav, '', api)
  return (
    <nav ref={nav} aria-label="Taskbar" className="ws-taskbar">
      <button type="button" aria-label="Open launcher" aria-expanded={open} onClick={() => setOpen((v) => !v)}><svg><path d="M0 0" /></svg></button>
      <button type="button" aria-label="Firefox" onContextMenu={(e) => { e.preventDefault(); setMenu(true) }}>F</button>
      {menu && <span data-testid="menu">Move to desktop 2</span>}
    </nav>
  )
}

it('paths find the same element again', () => {
  document.body.innerHTML = '<nav><div><button aria-label="A">a</button><button title="B"><i>x</i></button></div></nav>'
  const nav = document.querySelector('nav')!
  const i = document.querySelector('i')!
  expect(nodePath(nav, i)).toEqual([0, 1, 0])
  expect(resolvePath(nav, [0, 1, 0])).toBe(i)
  expect(controlLabel(i)).toBe('B')
  expect(nodePath(document.createElement('div'), i)).toBeNull()
  expect(performTaskbarEvent(nav, { kind: 'click', path: [-1], label: 'A' })).toBe(false)
  expect(performTaskbarEvent(nav, null)).toBe(false)
})

it('mirrors the taskbar, and a click or right-click there acts in the shell window', async () => {
  const { api, published } = bus()
  const ownerHost = document.createElement('div'); document.body.appendChild(ownerHost)
  const barHost = document.createElement('div'); document.body.appendChild(barHost)
  const owner = createRoot(ownerHost); const bar = createRoot(barHost); roots = [owner, bar]
  await act(async () => { owner.render(<Owner api={api} />) })
  await act(async () => { bar.render(<TaskbarWindow api={api} />) })
  await settle()
  const copy = () => barHost.querySelector('[data-testid="taskbar-window"]')!
  expect(copy().querySelector('button[aria-label="Open launcher"]')).not.toBeNull()
  // Click on the icon inside the copied Start button: the shell window's Start toggles, and the copy follows.
  await act(async () => { copy().querySelector('path')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await settle()
  expect(ownerHost.querySelector('button[aria-label="Open launcher"]')!.getAttribute('aria-expanded')).toBe('true')
  expect(copy().querySelector('button[aria-label="Open launcher"]')!.getAttribute('aria-expanded')).toBe('true')
  await act(async () => { copy().querySelector('button[aria-label="Firefox"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  await settle()
  expect(ownerHost.querySelector('[data-testid="menu"]')).not.toBeNull()
  expect(published.every((p) => p.output === '')).toBe(true)
  // Touch mode's taller taskbar reaches the copy (index.css :root[data-touch] .ws-taskbar).
  document.documentElement.setAttribute('data-touch', '')
  await settle()
  expect(published[published.length - 1].attrs['data-touch']).toBe('')
})

it('carries inline styles through the CSSOM (the CSP drops style attributes in markup)', async () => {
  const { mirrorMarkup, applyMirroredStyles } = await import('./taskbarMirror')
  document.body.innerHTML = '<nav><span style="width: 40%;">x</span></nav>'
  const html = mirrorMarkup(document.querySelector('nav')!)
  expect(html).not.toContain(' style=')
  expect(document.querySelector('span')!.getAttribute('style')).toBe('width: 40%;')   // the original keeps its style
  const box = document.createElement('div'); box.innerHTML = html
  applyMirroredStyles(box)
  expect((box.querySelector('span') as HTMLElement).style.width).toBe('40%')
})

it('finds the control by its name when the taskbar changed in between', () => {
  document.body.innerHTML = '<nav><span></span><button aria-label="Notifications">n</button></nav>'
  const nav = document.querySelector('nav')!
  let clicked = 0
  nav.querySelector('button')!.addEventListener('click', () => { clicked++ })
  const e: TaskbarEvent = { kind: 'click', path: [0], label: 'Notifications' }
  expect(performTaskbarEvent(nav, e)).toBe(true)
  expect(clicked).toBe(1)
})
