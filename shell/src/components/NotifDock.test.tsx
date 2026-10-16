// @vitest-environment jsdom
// App notifications in the notification centre: clicking the card (or Enter on its text) opens it like Open does;
// the action and dismiss buttons stay separate.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import NotifDock from './NotifDock'

let root: ReturnType<typeof createRoot>, el: HTMLDivElement
afterEach(() => { act(() => root.unmount()); el.remove(); delete window.worksuiteNotifications })

async function dock() {
  const invoke = vi.fn(async () => true), dismiss = vi.fn(async () => true)
  window.worksuiteNotifications = { list: async () => [], invoke, dismiss, onChange: () => () => {} }
  const setNotices = vi.fn()
  const notices = [{ id: 'app-7', tone: 'ok' as const, title: 'Ama', body: 'Hi there', app: 'WhatsApp', actions: [{ key: 'reply', label: 'Reply' }], at: Date.now() }]
  el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  await act(async () => root.render(<NotifDock now={new Date()} time="09:00" notices={notices} setNotices={setNotices} dnd={false} setDnd={() => {}} />))
  return { invoke, dismiss, setNotices }
}
const click = (n: Element) => act(async () => { (n as HTMLElement).click() })

describe('app notification card', () => {
  it('opens (default action) on a click on the card body', async () => {
    const { invoke, setNotices } = await dock()
    await click(el.querySelector('[data-testid="app-notice"]')!)
    expect(invoke).toHaveBeenCalledWith(7, 'default')
    expect(setNotices).toHaveBeenCalled()
  })
  it('opens from the keyboard: the text is a focusable button', async () => {
    const { invoke } = await dock()
    const b = el.querySelector<HTMLButtonElement>('[data-testid="app-notice-open"]')!
    expect(b.tagName).toBe('BUTTON')
    b.focus(); expect(document.activeElement).toBe(b)
    await click(b) // Enter/Space on a native button fire click
    expect(invoke).toHaveBeenCalledWith(7, 'default')
  })
  it('keeps the other actions and dismiss separate', async () => {
    const { invoke, dismiss } = await dock()
    const buttons = [...el.querySelectorAll('[data-testid="app-notice"] button')]
    await click(buttons.find((b) => b.textContent === 'Reply')!)
    expect(invoke).toHaveBeenCalledWith(7, 'reply')
    expect(invoke).not.toHaveBeenCalledWith(7, 'default')
    await click(buttons.find((b) => b.textContent === 'Dismiss')!)
    expect(dismiss).toHaveBeenCalledWith(7)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
