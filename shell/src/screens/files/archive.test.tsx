// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CompressDialog, childrenOf } from './archive'
import type { ArchiveEntry } from '../../lib/os'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

const e = (path: string, type: ArchiveEntry['type'] = 'file'): ArchiveEntry => ({ path, type, size: 3, link: null, modified: null, encrypted: false })
const radio = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) => b.textContent === name)!
const button = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!
const input = (label: string) => [...host!.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input')!
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('archive view and compress dialog', () => {
  it('lists the entries inside a folder, with folders that only appear as prefixes', () => {
    const all = [e('a/b/c.txt'), e('a/d.txt'), e('top.txt'), e('e', 'dir')]
    expect(childrenOf(all, '').map((n) => [n.name, n.dir])).toEqual([['a', true], ['e', true], ['top.txt', false]])
    expect(childrenOf(all, 'a').map((n) => [n.path, n.dir])).toEqual([['a/b', true], ['a/d.txt', false]])
  })

  it('offers formats, levels and a password only for zip and 7z', () => {
    const onSubmit = vi.fn()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root!.render(<CompressDialog names={['Budget.xlsx', 'Notes']} onCancel={() => undefined} onSubmit={onSubmit} />))
    expect(input('Archive name').value).toBe('Archive')
    act(() => radio('tar.xz').click())
    expect(input('Password (optional)').disabled).toBe(true)
    act(() => radio('7z').click())
    act(() => radio('Smallest').click())
    act(() => type(input('Password (optional)'), 'pässword'))
    act(() => button('Compress').click())
    expect(onSubmit).toHaveBeenCalledWith({ format: '7z', name: 'Archive', level: 9, password: 'pässword' })
    act(() => radio('zip').click())
    expect(host.querySelector('[role=alert]')?.textContent).toMatch(/English letters/)
    expect(button('Compress').disabled).toBe(true)
  })
})
