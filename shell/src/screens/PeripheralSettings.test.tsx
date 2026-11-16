// @vitest-environment jsdom
// Settings sections for Bluetooth pairing, drives, power, printers, input methods (WSOS-INT-003…006, 011) and rejected
// sync changes (WSOS-SYN-004), against a fake bridge that records the calls.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { BtPrompt, PeripheralsApi, Volume } from '../lib/peripheralsApi'
import { failureKind } from '../lib/peripheralsApi'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
const calls: string[] = []
const ok = <T,>(value: T) => ({ available: true as const, value })
let vols: Volume[] = [{ device: '/dev/sdb2', disk: '/dev/sdb', label: 'secret', size: '15G', fstype: 'crypto_LUKS', mountpoint: null, encrypted: true, unlocked: null }]
let enabled = ['keyboard-us']
let capturing = 0
const fake: PeripheralsApi = {
  async btScan() { calls.push('scan'); return ok([{ address: 'AA:BB:CC:DD:EE:01', name: 'Keyboard K380' }]) },
  async btPair(a) { calls.push(`pair ${a}`); return ok(true as const) },
  async btRemove(a) { calls.push(`remove ${a}`); return ok(true as const) },
  async volumes() { return ok(vols) },
  async volMount(d) { calls.push(`mount ${d}`); return ok('/media/u/x') },
  async volUnlock(d, p) {
    calls.push(`unlock ${d}`)
    if (p !== 'right') return { available: false, reason: 'bad_passphrase' }
    vols = [{ ...vols[0], unlocked: '/dev/mapper/luks-1', mountpoint: '/media/u/secret' }]
    return ok('/media/u/secret')
  },
  async volEject(d) { calls.push(`eject ${d}`); return { available: false, reason: 'storage_busy' } },
  async powerProfiles() { return ok({ active: 'balanced', profiles: ['power-saver', 'balanced', 'performance'], degraded: null }) },
  async setPowerProfile(n) { calls.push(`profile ${n}`); return ok(true as const) },
  async inhibitors() { return ok([{ what: 'sleep', who: 'Videos', why: 'Playing', mode: 'block' }]) },
  async findPrinters() { return ok([{ uri: 'ipp://10.0.0.5/ipp/print', name: 'Office' }]) },
  async addPrinter(u, n) { calls.push(`add ${u} ${n}`); return ok('Office') },
  async removePrinter() { return ok(true as const) },
  async printQueue() { return ok({ jobs: [{ id: 'Office-3', printer: 'Office', user: 'u', size: '10' }], issues: [{ name: 'Office', reason: 'Paper jam' }] }) },
  async cancelJob(id) { calls.push(`cancel ${id}`); return ok(true as const) },
  // Settings › Printers has its own page and tests (settings/Printers.test.tsx).
  async printers() { return ok([]) },
  async printerDrivers() { return ok([]) },
  async setDefaultPrinter() { return ok(true as const) },
  async pausePrinter() { return ok(true as const) },
  async printTestPage() { return ok('') },
  async printerPrefs() { return ok({ options: [], orientation: '3', copies: 1 }) },
  async setPrinterPrefs() { return ok(true as const) },
  async holdJob() { return ok(true as const) },
  async screenCapture() { return ok(capturing) },
  async stopScreenCapture() { calls.push('stop capture'); const n = capturing; capturing = 0; return ok(n) },
  async inputMethods() { return ok({ enabled, available: ['keyboard-us', 'm17n_si_wijesekera', 'm17n_ta_tamil99'] }) },
  async setInputMethods(ids) { calls.push(`ims ${ids.join(',')}`); enabled = ids; return ok(true as const) },
  async imStatus() { return ok({ running: true, current: 'keyboard-us', enabled }) },
  async setCurrentIm(id) { return ok(id) },
  async syncFailed() { return { ok: true, value: [{ mutation_id: 'm-1', module: 'crm', object_id: 'lead-7', last_error: '403 forbidden' }] } },
  async syncRetry(id) { calls.push(`retry ${id}`); return { ok: true, value: true } },
}

let Mod: typeof import('./PeripheralSettings')
beforeAll(async () => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { worksuitePeripherals: PeripheralsApi }).worksuitePeripherals = fake
  Mod = await import('./PeripheralSettings')
})

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; calls.length = 0 })
async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(el) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return host
}
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)) }) }
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('Bluetooth pairing (WSOS-INT-003)', () => {
  it('searches, pairs a found device and forgets a paired one', async () => {
    const changed: string[] = []
    const h = await render(<Mod.BluetoothPairSection powered paired={[{ address: 'AA:BB:CC:DD:EE:09', name: 'Headset' }]} onChange={() => changed.push('x')} />)
    await click(button('Search'))
    expect(h.textContent).toContain('Keyboard K380')
    await click(button('Pair'))
    await click(button('Remove'))
    expect(calls).toEqual(['scan', 'pair AA:BB:CC:DD:EE:01', 'remove AA:BB:CC:DD:EE:09'])
    expect(changed).toHaveLength(2)
  })
  it('asks to turn Bluetooth on first', async () => {
    const h = await render(<Mod.BluetoothPairSection powered={false} paired={[]} onChange={() => {}} />)
    expect(h.textContent).toContain('Turn Bluetooth on')
    expect(button('Search').disabled).toBe(true)
  })
})

describe('Bluetooth pairing dialog (WSOS-INT-003)', () => {
  const agentApi = (answers: string[]) => ({
    ...fake,
    async btAgentRespond(id: string, v: string) { answers.push(`respond ${id} ${v}`); return true },
    async btAgentCancel(id: string) { answers.push(`cancel ${id}`); return true },
  })
  const dialog = async (prompt: BtPrompt, answers: string[], timeoutMs?: number) => {
    const closed: string[] = []
    await render(<Mod.BtPairDialog prompt={prompt} api={agentApi(answers)} onClose={() => closed.push('x')} timeoutMs={timeoutMs} />)
    return closed
  }
  const input = () => document.querySelector('[role="dialog"] input, form input') as HTMLInputElement
  const submit = async () => { await act(async () => { document.querySelector('form')!.requestSubmit(); await new Promise((r) => setTimeout(r, 0)) }) }

  it('asks for a passkey, refuses one out of range, sends a valid one', async () => {
    const a: string[] = []
    const closed = await dialog({ id: 'bt1', kind: 'requestPasskey', address: 'AA:BB:CC:DD:EE:01' }, a)
    expect(document.body.textContent).toContain('Type the passkey shown on AA:BB:CC:DD:EE:01')
    type(input(), '12a')
    await submit()
    expect(document.body.textContent).toContain('up to 6 digits')
    type(input(), '012345')
    await submit()
    expect(a).toEqual(['respond bt1 012345'])
    expect(closed).toHaveLength(1)
  })
  it('asks for a PIN and refuses a malformed one', async () => {
    const a: string[] = []
    await dialog({ id: 'bt2', kind: 'requestPinCode', address: 'AA:BB:CC:DD:EE:01' }, a)
    type(input(), 'ab cd')
    await submit()
    expect(a).toEqual([])
    type(input(), '0000')
    await submit()
    expect(a).toEqual(['respond bt2 0000'])
  })
  it('shows a passkey to confirm, and Cancel rejects it', async () => {
    const a: string[] = []
    await dialog({ id: 'bt3', kind: 'requestConfirmation', address: 'AA:BB:CC:DD:EE:01', passkey: 4321 }, a)
    expect(document.querySelector('[data-testid="bt-code"]')!.textContent).toBe('004321')
    await click(button('Cancel'))
    expect(a).toEqual(['cancel bt3'])
  })
  it('confirms matching codes', async () => {
    const a: string[] = []
    await dialog({ id: 'bt4', kind: 'requestConfirmation', address: 'AA:BB:CC:DD:EE:01', passkey: 1 }, a)
    await click(button('Codes match'))
    expect(a).toEqual(['respond bt4 yes'])
  })
  it('shows a passkey or PIN to type on the device, with only Cancel', async () => {
    const a: string[] = []
    await dialog({ id: 'bt5', kind: 'displayPasskey', address: 'AA:BB:CC:DD:EE:01', passkey: 123456, entered: 2 }, a)
    expect(document.querySelector('[data-testid="bt-code"]')!.textContent).toBe('123456')
    expect(document.body.textContent).toContain('2 keys typed')
    expect(button('Pair')).toBeUndefined()
    act(() => root?.unmount()); root = null
    await dialog({ id: 'bt6', kind: 'displayPinCode', address: 'AA:BB:CC:DD:EE:01', pin: '9876' }, a)
    expect(document.querySelector('[data-testid="bt-code"]')!.textContent).toBe('9876')
  })
  it('times out and rejects so pairing never hangs', async () => {
    expect(Mod.BT_PROMPT_TIMEOUT_MS).toBe(30_000)
    const a: string[] = []
    const closed = await dialog({ id: 'bt7', kind: 'requestPasskey', address: 'AA:BB:CC:DD:EE:01' }, a, 30)
    expect(a).toEqual([])
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(a).toEqual(['cancel bt7'])
    expect(closed).toHaveLength(1)
  })
  it('opens from the agent while a device pairs', async () => {
    let push: ((p: BtPrompt | null) => void) | null = null
    ;(window as unknown as { worksuitePeripherals: PeripheralsApi }).worksuitePeripherals = { ...fake, onBtAgent: (cb) => { push = cb; return () => { push = null } } }
    try {
      await render(<Mod.BluetoothPairSection powered paired={[]} onChange={() => {}} />)
      await act(async () => { push!({ id: 'bt8', kind: 'displayPinCode', address: 'AA:BB:CC:DD:EE:01', pin: '1111' }) })
      expect(document.body.textContent).toContain('Pair a Bluetooth device')
      await act(async () => { push!(null) })
      expect(document.body.textContent).not.toContain('Pair a Bluetooth device')
    } finally { (window as unknown as { worksuitePeripherals: PeripheralsApi }).worksuitePeripherals = fake }
  })
})

describe('removable drives (WSOS-INT-004)', () => {
  it('unlocks a LUKS drive, explains a wrong passphrase and a busy eject, shows policy', async () => {
    const h = await render(<Mod.StorageSection usbPolicy="read_only" />)
    expect(h.textContent).toContain('read-only')
    await click(button('Unlock'))
    const pass = document.querySelector('input[type=password]') as HTMLInputElement
    type(pass, 'wrong')
    await click(document.querySelector('button[type=submit]')!)
    expect(document.body.textContent).toContain('Wrong passphrase')
    type(document.querySelector('input[type=password]') as HTMLInputElement, 'right')
    await click(document.querySelector('button[type=submit]')!)
    expect(h.textContent).toContain('Open at /media/u/secret')
    await click(button('Eject'))
    expect(h.textContent).toContain('A program is still using this drive')
    expect(calls).toEqual(['unlock /dev/sdb2', 'unlock /dev/sdb2', 'eject /dev/sdb2'])
  })
})

describe('power, input methods (WSOS-INT-005, 011)', () => {
  it('switches the power profile and lists programs blocking sleep', async () => {
    const h = await render(<Mod.PowerSection />)
    expect(h.textContent).toContain('Videos is blocking sleep')
    const perf = [...h.querySelectorAll('label')].find((l) => l.textContent === 'Performance')!.querySelector('input')!
    await click(perf)
    expect(calls).toEqual(['profile performance'])
  })
  it('turns on Sinhala input', async () => {
    const h = await render(<Mod.InputMethodsSection />)
    await click(h.querySelector('[aria-label="Sinhala (Wijesekara)"]')!)
    expect(calls).toEqual(['ims keyboard-us,m17n_si_wijesekera'])
  })
})

describe('rejected sync changes (WSOS-SYN-004)', () => {
  it('shows the error against the record and retries only on request', async () => {
    const h = await render(<Mod.SyncProblemsSection />)
    expect(h.textContent).toContain('crm record lead-7')
    expect(h.textContent).toContain('You do not have permission')
    expect(calls).toEqual([])
    await click(button('Try again'))
    expect(calls).toEqual(['retry m-1'])
    expect(failureKind('422 validation_failed: name required')).toBe('validation')
  })
})

describe('screen capture indicator (WSOS-INT-013)', () => {
  it('shows while a capture runs and disappears after', async () => {
    const { CaptureBadge } = await import('../components/CaptureBadge')
    capturing = 1
    const h = await render(<CaptureBadge pollMs={10} />)
    expect(h.textContent).toContain('Sharing screen')
    capturing = 0
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(h.textContent).toBe('')
  })
  it('Stop sharing ends every screencast in one click (SRS §7.1)', async () => {
    const { CaptureBadge } = await import('../components/CaptureBadge')
    capturing = 2
    const h = await render(<CaptureBadge pollMs={10_000} />)
    const btn = [...h.querySelectorAll('button')].find((b) => b.textContent === 'Stop sharing')!
    expect(btn).toBeTruthy()
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 10)) })
    expect(calls).toContain('stop capture')
    expect(h.textContent).toBe('')
  })
})
