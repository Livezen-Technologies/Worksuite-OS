// @vitest-environment jsdom
// Settings › Printers (WSOS-INT-006, issue #51) against a fake bridge that records the calls: the printer list with
// state and problems, default, pause/resume, test page, preferences, removal with confirmation, the queue, and adding
// a discovered USB printer (driver detection) or one by IP address.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { addressUri, type PeripheralsApi, type PrinterInfo } from '../../lib/peripheralsApi'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
const calls: string[] = []
const ok = <T,>(value: T) => ({ available: true as const, value })
let printers: PrinterInfo[] = []
const reset = () => {
  printers = [
    { name: 'Office', description: 'Office printer', location: 'Floor 3', uri: 'ipp://10.0.0.5/ipp/print', state: 'idle', message: null, isDefault: true },
    { name: 'Lab', description: '', location: '', uri: 'usb://HP/LaserJet', state: 'paused', message: 'Paper jam', isDefault: false },
  ]
}
const fake = {
  async printers() { return ok(printers) },
  async printQueue() { return ok({ jobs: [{ id: 'Office-3', printer: 'Office', user: 'u', size: '10' }, { id: 'Lab-4', printer: 'Lab', user: 'u', size: '9', held: true }], issues: [] }) },
  async findPrinters() {
    return ok([{ uri: 'usb://Brother/HL-L2350DW?serial=E7', name: 'Brother HL-L2350DW', makeModel: 'Brother HL-L2350DW series', deviceId: 'MFG:Brother;MDL:HL-L2350DW;', kind: 'usb' as const }])
  },
  async printerDrivers(u: string, mm: string, id: string) {
    calls.push(`drivers ${u} ${mm} ${id}`)
    return ok([{ id: 'drv:///brlaser.drv/br2350.ppd', label: 'Brother HL-L2350DW, using brlaser', recommended: true }])
  },
  async addPrinter(u: string, n: string, d?: string) { calls.push(`add ${u} ${n} ${d}`); return u.includes('10.9.9.9') ? { available: false as const, reason: 'printer_unreachable' }
    : u.includes('10.8.8.8') ? { available: false as const, reason: 'printer_failed', detail: 'lpadmin: Unable to copy PPD file.' } : ok(n) },
  async removePrinter(n: string) { calls.push(`remove ${n}`); printers = printers.filter((p) => p.name !== n); return ok(true as const) },
  async setDefaultPrinter(n: string) { calls.push(`default ${n}`); return ok(true as const) },
  async pausePrinter(n: string, p: boolean) { calls.push(`${p ? 'pause' : 'resume'} ${n}`); return ok(true as const) },
  async printTestPage(n: string) { calls.push(`test ${n}`); return ok(`${n}-9`) },
  async printerPrefs() {
    return ok({ options: [{ key: 'PageSize', label: 'Media Size', choices: ['Letter', 'A4'], current: 'A4' }, { key: 'Duplex', label: '2-Sided', choices: ['None', 'DuplexNoTumble'], current: 'None' }], orientation: '3', copies: 1 })
  },
  async setPrinterPrefs(n: string, v: Record<string, string>) { calls.push(`prefs ${n} ${JSON.stringify(v)}`); return ok(true as const) },
  async cancelJob(id: string) { calls.push(`cancel ${id}`); return ok(true as const) },
  async holdJob(id: string, h: boolean) { calls.push(`${h ? 'hold' : 'release'} ${id}`); return ok(true as const) },
} as unknown as PeripheralsApi

let Mod: typeof import('./Printers')
beforeAll(async () => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { worksuitePeripherals: PeripheralsApi }).worksuitePeripherals = fake
  Mod = await import('./Printers')
})
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; calls.length = 0 })
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
async function render() {
  reset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<Mod.PrintersPanel />) })
  await tick()
  return host
}
const buttons = (label: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent === label) as HTMLButtonElement[]
const button = (label: string) => buttons(label)[0]
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }); await tick(); await tick() }
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function pick(select: HTMLSelectElement, value: string) {
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('Settings › Printers (issue #51)', () => {
  it('lists printers with state, problems and the default; manages them and the queue', async () => {
    const h = await render()
    expect(h.textContent).toContain('Office printer')
    expect(h.textContent).toContain('Default')
    expect(h.textContent).toContain('Paused · Paper jam')
    await click(button('Make default'))          // only Lab offers it
    await click(button('Resume'))                // Lab is paused
    await click(buttons('Pause')[0])             // Office
    await click(buttons('Print test page')[0])
    expect(h.textContent).toContain('Test page sent to Office printer.')
    await click(button('Release'))
    await click(button('Hold'))
    await click(buttons('Cancel')[0])
    expect(calls).toEqual(['default Lab', 'resume Lab', 'pause Office', 'test Office', 'release Lab-4', 'hold Office-3', 'cancel Office-3'])
  })

  it('asks before removing a printer', async () => {
    const h = await render()
    await click(buttons('Remove')[1])
    expect(document.body.textContent).toContain('Remove Lab?')
    await click([...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === 'Remove')!)
    expect(calls).toEqual(['remove Lab'])
    expect(h.textContent).toContain('Lab removed.')
  })

  it('saves preferences only from the offered values and checks copies', async () => {
    await render()
    await click(buttons('Preferences')[0])
    const selects = [...document.querySelectorAll('[role=dialog] select')] as HTMLSelectElement[]
    expect(selects.map((s) => s.value)).toEqual(['A4', 'None', '3'])
    pick(selects[1], 'DuplexNoTumble'); pick(selects[2], '4')
    const copies = document.querySelector('[role=dialog] input[type=number]') as HTMLInputElement
    type(copies, '0')
    await click(button('Save'))
    expect(document.body.textContent).toContain('Copies must be a number from 1 to 99.')
    type(copies, '2')
    await click(button('Save'))
    expect(calls).toEqual(['prefs Office {"PageSize":"A4","Duplex":"DuplexNoTumble","orientation-requested":"4","copies":"2"}'])
    expect(document.body.textContent).toContain('Printing preferences saved.')
  })

  it('adds a USB printer with the detected driver', async () => {
    const h = await render()
    await click(button('Add printer'))
    await click([...document.querySelectorAll('[role=dialog] label')].find((l) => l.textContent?.startsWith('Brother HL-L2350DW'))!.querySelector('input')!)
    expect(calls).toEqual(['drivers usb://Brother/HL-L2350DW?serial=E7 Brother HL-L2350DW series MFG:Brother;MDL:HL-L2350DW;'])
    expect(document.body.textContent).toContain('Brother HL-L2350DW, using brlaser (recommended)')
    await click(document.querySelector('[role=dialog] button[type=submit]')!)
    expect(calls[1]).toBe('add usb://Brother/HL-L2350DW?serial=E7 Brother HL-L2350DW drv:///brlaser.drv/br2350.ppd')
    expect(h.textContent).toContain('Printer Brother HL-L2350DW added.')
  })

  it('adds a printer by IP address, validating it and showing CUPS errors', async () => {
    await render()
    await click(button('Add printer'))
    await click(button('By address'))
    const host = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.textContent?.startsWith('Host name'))!.querySelector('input')!
    type(host, '300.1.1.1')
    expect(document.body.textContent).toContain('Enter a valid host name or IP address')
    type(host, '10.9.9.9')
    await tick()
    await click(document.querySelector('[role=dialog] button[type=submit]')!)
    expect(calls).toEqual(['add ipp://10.9.9.9/ipp/print 10.9.9.9 everywhere'])
    expect(document.body.textContent).toContain('The printer did not answer')
  })
  it('#51: shows what lpadmin said, and the Driver row does not appear mid-typing (no layout jump)', async () => {
    await render()
    await click(button('Add printer'))
    await click(button('By address'))
    const sel = () => document.querySelector('[data-testid=printer-driver]') as HTMLSelectElement | null
    expect(sel()?.disabled).toBe(true)  // there before an address is typed
    const host = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.textContent?.startsWith('Host name'))!.querySelector('input')!
    type(host, '10.8.8.8')
    await tick()
    expect(sel()?.disabled).toBe(false)
    expect(sel()?.value).toBe('everywhere')
    await click(document.querySelector('[role=dialog] button[type=submit]')!)
    expect(document.body.textContent).toContain('That did not work. Try again. Printing system: lpadmin: Unable to copy PPD file.')
  })
})

describe('addressUri', () => {
  it('builds printer URIs from a typed host', () => {
    expect(addressUri('ipp', '192.168.1.20')).toBe('ipp://192.168.1.20/ipp/print')
    expect(addressUri('ipps', 'printer.local', 'printers/lab')).toBe('ipps://printer.local/printers/lab')
    expect(addressUri('socket', '10.0.0.7')).toBe('socket://10.0.0.7:9100')
    expect(addressUri('socket', '10.0.0.7:9101')).toBe('socket://10.0.0.7:9101')
    expect(addressUri('lpd', 'fe80::1')).toBe('lpd://[fe80::1]/queue')
    expect(addressUri('ipp', '999.1.1.1')).toBeNull()
    expect(addressUri('ipp', 'a b')).toBeNull()
    expect(addressUri('ipp', 'host', '../x?y')).toBeNull()
  })
})
