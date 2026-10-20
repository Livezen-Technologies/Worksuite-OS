// @vitest-environment jsdom
// The AI assistant panel and Settings › AI against a fake worksuite-ai bridge: every state the panel has (service
// down, policy off, switched off, no model, setup, ready), streaming, Stop, Copy, New chat, history, context actions.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Assistant from './Assistant'
import { AIPanel } from '../screens/settings/AI'
import { resetForTests, buildMessages, LOCAL_SYSTEM, loadPrefs, savePrefs } from '../lib/assistant'
import { suggestedModel, problemKind, stageOf, timeLeftLabel, type AIApi, type LocalAIEvent, type LocalAIStatus, type LocalModelView } from '../lib/aiApi'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
beforeAll(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
let root: Root | null = null
let host: HTMLDivElement | null = null

const GB = 1024 ** 3
const model = (over: Partial<LocalModelView> = {}, m: Partial<LocalModelView['model']> = {}): LocalModelView => ({
  model: { id: 'qwen3.5-2b-q4', version: '1', name: 'Qwen3.5 2B', family: 'qwen3.5', purpose: 'chat', url: 'https://cdn.worksuite.app/m.gguf', sha256: 'a'.repeat(64), bytes: Math.round(1.3 * GB),
    quantization: 'Q4_K_M', contextLength: 262144, minMemoryBytes: 3 * GB, tiers: ['minimal', 'basic'], recommendedFor: ['basic'], license: { id: 'Apache-2.0', name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' }, languages: [], toolCalling: true, ...m },
  state: 'available', received: 0, error: null, fits: true, recommended: true, isDefault: false, readiness: 'untested', readinessError: null, ...over,
})
const status = (over: Partial<LocalAIStatus> = {}): LocalAIStatus => ({
  runtime: 'off', error: null, loaded: null, catalogError: null, catalogAt: '2026-10-16T00:00:00Z',
  hardware: { platform: 'linux', arch: 'x64', memoryBytes: 16 * GB, freeDiskBytes: 100 * GB, cpuCores: 8, cpuModel: 'x', gpu: false, vulkan: true, vramBytes: 0, tier: 'good', autoThreads: 6 },
  policy: { managed: false, enabled: true, models: null }, settings: { enabled: true, threads: 0, gpu: true }, ...over,
})

function fakeAI(s: LocalAIStatus | null, models: LocalModelView[]) {
  const listeners = new Set<(e: LocalAIEvent) => void>()
  const api = {
    status: vi.fn(async () => (s ? { ok: true, value: s } : { ok: false, error: 'service_unavailable' })),
    models: vi.fn(async () => (s ? { ok: true, value: models } : { ok: false, error: 'service_unavailable' })),
    refresh: vi.fn(async () => ({ ok: true, value: true })), install: vi.fn(async () => ({ ok: true, value: true })), cancel: vi.fn(async () => ({ ok: true, value: true })),
    remove: vi.fn(async () => ({ ok: true, value: true })), setDefault: vi.fn(async () => ({ ok: true, value: true })), check: vi.fn(async () => ({ ok: true, value: true })),
    test: vi.fn(async () => ({ ok: true, value: true })), restart: vi.fn(async () => ({ ok: true, value: true })),
    setSettings: vi.fn(async (p: object) => ({ ok: true, value: { ...s!.settings, ...p } })),
    ask: vi.fn(async (_req: unknown) => ({ ok: true, value: true })), cancelAsk: vi.fn(async () => ({ ok: true, value: true })),
    selection: vi.fn(async () => ({ ok: true, value: 'The quarterly report says sales rose 12%.' })), clipboard: vi.fn(async () => ({ ok: false, error: 'no_clipboard' })),
    readFile: vi.fn(async () => ({ ok: true, value: { name: 'notes.txt', text: 'Meeting at 10.' } })),
    onEvent: (cb: (e: LocalAIEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    onChanged: () => () => {},
    emit: (e: LocalAIEvent) => act(() => { for (const l of [...listeners]) l(e) }),
  }
  ;(window as unknown as { worksuiteAI: AIApi }).worksuiteAI = api as unknown as AIApi
  return api
}

async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(el) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return host
}
const text = () => host!.textContent ?? ''
const button = (name: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name) as HTMLButtonElement
const click = (b: HTMLElement) => act(async () => { b.click(); await new Promise((r) => setTimeout(r, 0)) })
async function type(v: string) {
  const ta = host!.querySelector('textarea')!
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(ta, v); ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => { localStorage.clear(); resetForTests() })
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; delete (window as unknown as { worksuiteAI?: AIApi }).worksuiteAI; vi.restoreAllMocks() })

const props = { onClose: () => {}, onOpenSettings: () => {} }

describe('AI assistant panel', () => {
  it('always says the assistant runs on this device', async () => {
    fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    await render(<Assistant {...props} />)
    expect(text()).toContain('Runs on this device. Nothing leaves your computer.')
  })

  it('says when the service is not running, and lets nothing be asked', async () => {
    fakeAI(null, [])
    await render(<Assistant {...props} />)
    expect(text()).toContain('The AI service is not running')
    expect(host!.querySelector('textarea')!.disabled).toBe(true)
  })

  it('says when the organization turned it off', async () => {
    fakeAI(status({ policy: { managed: true, enabled: false, models: null } }), [model({ state: 'installed', isDefault: true })])
    await render(<Assistant {...props} />)
    expect(text()).toContain('Turned off by your organization')
    expect(host!.querySelector('textarea')!.disabled).toBe(true)
  })

  it('switched off by the person: Turn on', async () => {
    const api = fakeAI(status({ settings: { enabled: false, threads: 0, gpu: true } }), [])
    await render(<Assistant {...props} />)
    await click(button('Turn on'))
    expect(api.setSettings).toHaveBeenCalledWith({ enabled: true })
  })

  it('no model: the setup card offers the suggested one, with its size, space and licence', async () => {
    const api = fakeAI(status(), [model()])
    await render(<Assistant {...props} />)
    expect(text()).toContain('Set up your AI Assistant')
    expect(text()).toMatch(/Qwen3\.5 2B · 1\.4 GB download · needs 1\.9 GB of free space/)
    expect(text()).toContain('Apache License 2.0')
    await click(button('Download and set up'))
    expect(api.install).toHaveBeenCalledWith('qwen3.5-2b-q4')
  })

  it('a download in progress shows its stage, progress, Pause and Cancel', async () => {
    const api = fakeAI(status(), [model({ state: 'downloading', received: Math.round(0.65 * GB), bytesPerSecond: 10 * 1024 ** 2 })])
    await render(<Assistant {...props} />)
    expect(host!.querySelector('[aria-current="step"]')!.textContent).toContain('Downloading')
    expect(host!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('50')
    expect(text()).toMatch(/min left/)
    await click(button('Pause'))
    expect(api.cancel).toHaveBeenCalledWith('qwen3.5-2b-q4', false)
  })

  it('only unpublished models: no download is offered; the panel points to Settings, which says why', async () => {
    fakeAI(status(), [model({ state: 'unpublished' }, { sha256: '', bytes: 0, approxBytes: 1.3e9 })])
    await render(<Assistant {...props} />)
    expect(text()).toContain('No model on this computer can answer yet')
    expect(button('Download and set up')).toBeUndefined()
    act(() => root?.unmount()); host?.remove()
    await render(<AIPanel />)
    expect(text()).toContain('checksum has not been published')
    expect(text()).toContain('about 1.3 GB download')
    expect(button('Download and set up')).toBeUndefined()
  })

  it('streams an answer, then shows it as processed locally, with Copy', async () => {
    const api = fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    const write = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText: write } })
    await render(<Assistant {...props} />)
    await type('What is a GGUF file?')
    await click(button('Send'))
    const req = api.ask.mock.calls[0]![0] as { id: string; messages: { role: string; content: string }[] }
    expect(req.messages[0]!.role).toBe('system')
    expect(req.messages[0]!.content).toContain(LOCAL_SYSTEM)
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'What is a GGUF file?' })
    expect(host!.querySelector('[data-testid="ai-thinking"]')).toBeTruthy()
    await api.emit({ id: req.id, type: 'chunk', text: 'A model ' })
    await api.emit({ id: req.id, type: 'chunk', text: '**file** format.' })
    expect(text()).toContain('A model file format.')
    expect(button('Stop processing')).toBeTruthy()
    await api.emit({ id: req.id, type: 'done', text: 'A model **file** format.', tokens: 6, ms: 300, cancelled: false })
    expect(text()).toContain('Processed locally')
    expect(host!.querySelector('strong')!.textContent).toBe('file')
    await click(button('Copy'))
    expect(write).toHaveBeenCalledWith('A model **file** format.')
  })

  it('Stop cancels the answer and marks it stopped', async () => {
    const api = fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    await render(<Assistant {...props} />)
    await type('Count to a thousand')
    await click(button('Send'))
    const id = (api.ask.mock.calls[0]![0] as { id: string }).id
    await click(button('Stop processing'))
    expect(api.cancelAsk).toHaveBeenCalledWith(id)
    await api.emit({ id, type: 'done', text: '1, 2, 3', tokens: 3, ms: 10, cancelled: true })
    expect(text()).toContain('Stopped.')
    expect(text()).toContain('1, 2, 3')
  })

  it('out of memory: says so, with advice, Try again and Set up — never a made-up answer', async () => {
    const api = fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    await render(<Assistant {...props} />)
    await type('Hello')
    await click(button('Send'))
    const id = (api.ask.mock.calls[0]![0] as { id: string }).id
    await api.emit({ id, type: 'error', code: 'out_of_memory' })
    expect(text()).toContain('The model ran out of memory on this computer.')
    expect(text()).toContain('choose a smaller model')
    expect(button('Try again')).toBeTruthy()
    expect(text()).not.toContain('Processed locally')
  })

  it('summarises the selection only when asked, and says when there is none', async () => {
    const api = fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    await render(<Assistant {...props} />)
    await click(button('Summarise the selected text'))
    expect(api.selection).toHaveBeenCalled()
    const req = api.ask.mock.calls[0]![0] as { messages: { content: string }[] }
    expect(req.messages.at(-1)!.content).toContain('The quarterly report says sales rose 12%.')
    expect(text()).toContain('characters included')
    api.ask.mockClear()
    resetForTests()
  })

  it('an empty clipboard is said, not sent', async () => {
    const api = fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    await render(<Assistant {...props} />)
    await click(button('Summarise the clipboard'))
    expect(text()).toContain('The clipboard has no text.')
    expect(api.ask).not.toHaveBeenCalled()
  })

  it('explains a file from Files when opened with one', async () => {
    const api = fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    const handled = vi.fn()
    await render(<Assistant {...props} request={{ kind: 'file', root: 'home', rel: 'notes.txt' }} onRequestHandled={handled} />)
    expect(api.readFile).toHaveBeenCalledWith('home', 'notes.txt')
    expect(handled).toHaveBeenCalled()
    expect(text()).toContain('Explain notes.txt')
  })

  it('keeps history on this computer, clears it with New chat, and keeps none when off', async () => {
    const api = fakeAI(status(), [model({ state: 'installed', isDefault: true, readiness: 'ready' })])
    await render(<Assistant {...props} />)
    await type('Remember me')
    await click(button('Send'))
    const id = (api.ask.mock.calls[0]![0] as { id: string }).id
    await api.emit({ id, type: 'done', text: 'Noted.', tokens: 2, ms: 1, cancelled: false })
    expect(JSON.parse(localStorage.getItem('ws.ai.history')!)).toHaveLength(2)
    await click(button('New chat'))
    expect(JSON.parse(localStorage.getItem('ws.ai.history')!)).toHaveLength(0)
    savePrefs({ history: false })
    expect(loadPrefs().history).toBe(false)
    expect(localStorage.getItem('ws.ai.history')).toBeNull()
  })
})

describe('Settings › AI', () => {
  it('shows this computer, the models with size and memory, and the controls', async () => {
    const api = fakeAI(status(), [model(), model({ state: 'installed', isDefault: true, readiness: 'ready' }, { id: 'qwen3.5-0.8b-q4', name: 'Qwen3.5 0.8B', bytes: 560_000_000, minMemoryBytes: 1.5 * GB })])
    await render(<AIPanel />)
    expect(text()).toContain('8 cores')
    expect(text()).toContain('Good tier')
    expect(text()).toMatch(/1\.4 GB download · Q4_K_M · needs about 3\.2 GB of memory/)
    expect(text()).toContain('Ready to use')
    await click(button('Download and set up'))
    expect(api.install).toHaveBeenCalledWith('qwen3.5-2b-q4')
    const select = host!.querySelector('select')!
    await act(async () => { select.value = '4'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(api.setSettings).toHaveBeenCalledWith({ threads: 4 })
    await click(button('Use the graphics card'))
    expect(api.setSettings).toHaveBeenCalledWith({ gpu: false })
    await click(button('Clear'))
    expect(text()).toContain('Chat history cleared.')
  })

  it('a managed device: the policy is shown and the switch is locked off', async () => {
    fakeAI(status({ policy: { managed: true, enabled: false, models: null } }), [])
    await render(<AIPanel />)
    expect(text()).toContain('Your organization has turned off the AI assistant on this device')
    const sw = host!.querySelector('[role="switch"]') as HTMLButtonElement
    // Locked: still focusable so the reason can be read, but it can't be changed (components/Dk.tsx Switch).
    expect(sw.getAttribute('aria-disabled')).toBe('true')
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })
})

describe('setup logic (as Desktop)', () => {
  it('suggests the recommended model, else the smallest that fits; never an unpublished one', () => {
    const small = model({ recommended: false }, { id: 'a', bytes: GB })
    const rec = model({ recommended: true }, { id: 'b', bytes: 2 * GB })
    expect(suggestedModel([small, rec])!.model.id).toBe('b')
    expect(suggestedModel([small, model({ recommended: false }, { id: 'c', bytes: 3 * GB })])!.model.id).toBe('a')
    expect(suggestedModel([model({ state: 'unpublished' })])).toBeNull()
  })
  it('stages, problems and time left', () => {
    expect(stageOf(model({ state: 'failed', error: 'mismatch' }))).toEqual({ stage: 'verifying', stopped: 'failed' })
    expect(stageOf(model({ state: 'installed', readiness: 'testing' })).stage).toBe('preparing')
    expect(problemKind('no_space')).toBe('storage')
    expect(problemKind('out_of_memory', true)).toBe('memory')
    expect(timeLeftLabel(30)).toBe('less than a minute left')
    expect(timeLeftLabel(3900)).toBe('about 1 h 5 min left')
  })
  it('history sent back to the model fits the budget, starts with the person and skips errors', () => {
    const msgs = buildMessages([{ role: 'assistant', text: 'orphan' }, { role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }, { role: 'assistant', text: '', error: 'crashed' }], 'q3', 'si')
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs.at(-1)!.content).toBe('q3')
    expect(msgs[0]!.content).toContain('Answer in Sinhala')
  })
})
