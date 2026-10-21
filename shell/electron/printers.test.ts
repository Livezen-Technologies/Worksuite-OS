// Settings › Printers (WSOS-INT-006, issue #51) against recorded CUPS output. The regression this guards: on the
// tester's laptop cupsd answered "lpinfo: Forbidden" / "lpadmin: Forbidden" because the signed-in person was not in
// its lpadmin group, so nothing could be found or added; the bridge now goes through the polkit-gated helper.
import { describe, expect, it } from 'vitest'
import {
  PRINTER_ADMIN, TEST_PAGE, cupsError, driverId, parseDrivers, parseJobs, parseLpinfo, parseLpoptions, parseOptions, parsePrinters,
  printerUri, printersBridge, requestId,
} from './printers'
import type { Exec } from './system'

type Answer = { code?: number; stdout?: string; stderr?: string; missing?: boolean }
function fakeExec(answers: Record<string, Answer | Answer[]>) {
  const calls: string[] = []
  const exec: Exec = async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    calls.push(key)
    const hit = Object.keys(answers).find((k) => key.startsWith(k))
    const raw = hit ? answers[hit] : {}
    const a = Array.isArray(raw) ? raw.shift() ?? {} : raw
    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '', missing: a.missing }
  }
  return { exec, calls }
}

const LPSTAT_LP = `printer Lab disabled since Tue 13 Oct 2026 10:00:00 AM -
\tPaper jam
\tForm mounted:
\tDescription: Lab LaserJet
\tAlerts: media-jam-error
\tLocation: Room 2
printer Office is idle.  enabled since Tue 13 Oct 2026 09:00:00 AM
\tForm mounted:
\tDescription: Office printer
\tAlerts: none
\tLocation:
\tUsers allowed:
\t\t(all)
printer Wide now printing Wide-7.  enabled since Tue 13 Oct 2026 09:00:00 AM
\tDescription:
`
const LPINFO_L = `Device: uri = usb://Brother/HL-L2350DW%20series?serial=E78123
        class = direct
        info = Brother HL-L2350DW series
        make-and-model = Brother HL-L2350DW series
        device-id = MFG:Brother;CMD:PJL,PCL,PCLXL,URF;MDL:HL-L2350DW series;CLS:PRINTER;
        location =
Device: uri = dnssd://HP%20LaserJet%20M110w%20(5F2A1B)._ipp._tcp.local/?uuid=6d4ff0ce
        class = network
        info = HP LaserJet M110w (5F2A1B)
        make-and-model = HP LaserJet M110w
        device-id = MFG:HP;MDL:LaserJet M110w;
        location =
Device: uri = socket
        class = network
        info = AppSocket/HP JetDirect
        make-and-model = Unknown
        device-id =
Device: uri = ipp
        class = network
        info = Internet Printing Protocol (ipp)
        make-and-model = Unknown
        device-id =
`

describe('parsing CUPS output', () => {
  it('reads printers: state, message, description, location, address and the default', () => {
    const p = parsePrinters(LPSTAT_LP, 'device for Lab: usb://HP/LaserJet\ndevice for Office: ipp://10.0.0.5/ipp/print\n', 'system default destination: Office\n')
    expect(p).toEqual([
      { name: 'Lab', description: 'Lab LaserJet', location: 'Room 2', uri: 'usb://HP/LaserJet', state: 'paused', message: 'Paper jam', isDefault: false },
      { name: 'Office', description: 'Office printer', location: '', uri: 'ipp://10.0.0.5/ipp/print', state: 'idle', message: null, isDefault: true },
      { name: 'Wide', description: '', location: '', uri: '', state: 'printing', message: null, isDefault: false },
    ])
  })
  it('finds USB and network printers from lpinfo -l -v, skipping bare backends', () => {
    expect(parseLpinfo(LPINFO_L)).toEqual([
      { uri: 'usb://Brother/HL-L2350DW%20series?serial=E78123', name: 'Brother HL-L2350DW series', makeModel: 'Brother HL-L2350DW series', deviceId: 'MFG:Brother;CMD:PJL,PCL,PCLXL,URF;MDL:HL-L2350DW series;CLS:PRINTER;', kind: 'usb' },
      { uri: 'dnssd://HP%20LaserJet%20M110w%20(5F2A1B)._ipp._tcp.local/?uuid=6d4ff0ce', name: 'HP LaserJet M110w (5F2A1B)', makeModel: 'HP LaserJet M110w', deviceId: 'MFG:HP;MDL:LaserJet M110w;', kind: 'network' },
    ])
    expect(parseLpinfo('direct usb://Canon/LBP?serial=1\nnetwork socket\n')).toEqual([{ uri: 'usb://Canon/LBP?serial=1', name: 'Canon LBP', kind: 'usb' }])
  })
  it('lists drivers with IPP Everywhere first for driverless printers', () => {
    const text = 'drv:///brlaser.drv/br2350.ppd Brother HL-L2350DW series, using brlaser v6\ngutenprint.5.3://brother-hl-l2350dw/expert Brother HL-L2350DW - CUPS+Gutenprint v5.3.4\n'
    expect(parseDrivers(text, 'usb://Brother/HL')).toEqual([
      { id: 'drv:///brlaser.drv/br2350.ppd', label: 'Brother HL-L2350DW series, using brlaser v6', recommended: true },
      { id: 'gutenprint.5.3://brother-hl-l2350dw/expert', label: 'Brother HL-L2350DW - CUPS+Gutenprint v5.3.4', recommended: false },
    ])
    expect(parseDrivers('', 'ipp://10.0.0.5/ipp/print')).toEqual([{ id: 'everywhere', label: 'IPP Everywhere', recommended: true }])
    expect(driverId('-E')).toBeNull()
    expect(driverId('lsb/../../etc/shadow')).toBeNull()
  })
  it('reads options, preferences, jobs and request ids', () => {
    const opts = parseOptions('PageSize/Media Size: Letter Legal *A4 Env10\nColorModel/Color Mode: *RGB Gray\nDuplex/2-Sided Printing: *None DuplexNoTumble DuplexTumble\nResolution/Resolution: *600dpi\nprint-scaling/Scaling: *auto fit\n')
    expect(opts).toEqual([
      { key: 'PageSize', label: 'Media Size', choices: ['Letter', 'Legal', 'A4', 'Env10'], current: 'A4' },
      { key: 'ColorModel', label: 'Color Mode', choices: ['RGB', 'Gray'], current: 'RGB' },
      { key: 'Duplex', label: '2-Sided Printing', choices: ['None', 'DuplexNoTumble', 'DuplexTumble'], current: 'None' },
    ])
    expect(parseLpoptions("copies=2 device-uri=ipp://x/ipp/print orientation-requested=4 printer-info='Office printer'")).toMatchObject({ copies: '2', 'orientation-requested': '4', 'printer-info': 'Office printer' })
    expect(parseJobs('Office-12  alice  20480  Tue 13 Oct 2026\n\tStatus: \n\tAlerts: job-hold-until-specified\n\tqueued for Office\nLab-3 bob 10 Tue\n'))
      .toEqual([{ id: 'Office-12', printer: 'Office', user: 'alice', size: '20480', held: true }, { id: 'Lab-3', printer: 'Lab', user: 'bob', size: '10' }])
    expect(requestId('request id is Office-14 (1 file(s))\n')).toBe('Office-14')
  })
  it('maps CUPS errors and accepts only printer addresses', () => {
    expect(cupsError('lpinfo: Forbidden')).toBe('not_authorized')
    expect(cupsError('lpadmin: Unable to connect to "10.0.0.5:631": No route to host')).toBe('printer_unreachable')
    expect(cupsError('lpadmin: Bad device-uri scheme "foo".')).toBe('printer_bad_address')
    expect(cupsError('lpstat: Scheduler is not running.')).toBe('service_unavailable')
    expect(printerUri('socket://10.0.0.7:9100')).toBe('socket://10.0.0.7:9100')
    expect(printerUri('usb://HP/LaserJet?serial=1')).toBe('usb://HP/LaserJet?serial=1')
    expect(printerUri('file:///etc/shadow')).toBeNull()
    expect(printerUri('ipp://user:pw@host/')).toBeNull()
  })
})

describe('printers bridge', () => {
  it('runs administrative calls directly for lpadmin members', async () => {
    const { exec, calls } = fakeExec({ 'lpinfo': { stdout: LPINFO_L } })
    const r = await printersBridge(exec).findPrinters()
    expect(r.available && r.value).toHaveLength(2)
    expect(calls).toEqual(['lpinfo --timeout 10 -l -v'])
  })
  it('falls back to pkexec worksuite-printer-admin when cupsd says Forbidden (issue #51)', async () => {
    const { exec, calls } = fakeExec({ 'lpadmin': { code: 1, stderr: 'lpadmin: Forbidden\n' }, 'pkexec': { code: 0 } })
    const b = printersBridge(exec)
    expect(await b.addPrinter('usb://Brother/HL?serial=1', 'Brother HL', 'drv:///brlaser.drv/br2350.ppd')).toEqual({ available: true, value: 'Brother_HL' })
    expect(calls).toEqual([
      'lpadmin -p Brother_HL -E -v usb://Brother/HL?serial=1 -m drv:///brlaser.drv/br2350.ppd -D Brother HL',
      `pkexec ${PRINTER_ADMIN} add Brother_HL usb://Brother/HL?serial=1 drv:///brlaser.drv/br2350.ppd Brother HL`,
    ])
  })
  it('reports a dismissed or refused administrator prompt', async () => {
    const dismissed = fakeExec({ 'lpinfo': { code: 1, stderr: 'lpinfo: Forbidden' }, 'pkexec': { code: 126 } })
    expect(await printersBridge(dismissed.exec).findPrinters()).toEqual({ available: false, reason: 'auth_cancelled' })
    const refused = fakeExec({ 'cupsdisable': { code: 1, stderr: 'cupsdisable: Forbidden' }, 'pkexec': { code: 127 } })
    expect(await printersBridge(refused.exec).pausePrinter('Office', true)).toEqual({ available: false, reason: 'not_authorized' })
  })
  it('needs a driver for JetDirect/LPD/USB; IPP printers are driverless', async () => {
    const { exec, calls } = fakeExec({})
    const b = printersBridge(exec)
    expect(await b.addPrinter('socket://10.0.0.7:9100', 'Old', 'everywhere')).toEqual({ available: false, reason: 'printer_no_driver' })
    expect(await b.addPrinter('ipp://10.0.0.5/ipp/print', 'Office printer')).toEqual({ available: true, value: 'Office_printer' })
    expect(await b.addPrinter('ipp://10.0.0.5/ipp/print', 'x', '-h')).toEqual({ available: false, reason: 'invalid_argument' })
    expect(calls).toEqual(['lpadmin -p Office_printer -E -v ipp://10.0.0.5/ipp/print -m everywhere -D Office printer'])
  })
  it('looks up drivers by device id; no match still offers IPP Everywhere', async () => {
    const { exec, calls } = fakeExec({ 'lpinfo': { code: 1, stderr: 'lpinfo: No drivers found.' } })
    expect(await printersBridge(exec).printerDrivers('dnssd://HP._ipp._tcp.local/', 'HP LaserJet M110w', 'MFG:HP;MDL:LaserJet M110w;'))
      .toEqual({ available: true, value: [{ id: 'everywhere', label: 'IPP Everywhere', recommended: true }] })
    expect(calls).toEqual(['lpinfo --device-id MFG:HP;MDL:LaserJet M110w; -m'])
  })
  it('keeps the default and preferences per user (lpoptions), only with offered values', async () => {
    const l = 'PageSize/Media Size: Letter *A4\nDuplex/2-Sided Printing: *None DuplexNoTumble\n'
    const { exec, calls } = fakeExec({ 'lpoptions -p Office -l': { stdout: l }, 'lpoptions -p Office': { stdout: 'copies=1 orientation-requested=3' } })
    const b = printersBridge(exec)
    expect(await b.setDefaultPrinter('Office')).toEqual({ available: true, value: true })
    expect(await b.printerPrefs('Office')).toEqual({ available: true, value: { options: parseOptions(l), orientation: '3', copies: 1 } })
    expect(await b.setPrinterPrefs('Office', { PageSize: 'Tabloid' })).toEqual({ available: false, reason: 'invalid_argument' })
    expect(await b.setPrinterPrefs('Office', { copies: '100' })).toEqual({ available: false, reason: 'invalid_argument' })
    expect(await b.setPrinterPrefs('Office', { PageSize: 'Letter', Duplex: 'DuplexNoTumble', 'orientation-requested': '4', copies: '2' })).toEqual({ available: true, value: true })
    expect(calls.filter((c) => !c.endsWith(' -l') && c !== 'lpoptions -p Office')).toEqual([
      'lpoptions -d Office',
      'lpoptions -p Office -o PageSize=Letter -o Duplex=DuplexNoTumble -o orientation-requested=4 -o copies=2',
    ])
  })
  it('prints a test page, resumes and accepts, holds and cancels jobs', async () => {
    const { exec, calls } = fakeExec({ 'lp -d': { stdout: 'request id is Office-14 (1 file(s))' } })
    const b = printersBridge(exec)
    expect(await b.printTestPage('Office')).toEqual({ available: true, value: 'Office-14' })
    await b.pausePrinter('Office', false)
    await b.holdJob('Office-14', true)
    await b.cancelJob('Office-14')
    expect(await b.cancelJob('Office-14; rm')).toEqual({ available: false, reason: 'invalid_argument' })
    expect(calls).toEqual([`lp -d Office -t Test page ${TEST_PAGE}`, 'cupsenable Office', 'cupsaccept Office', 'lp -i Office-14 -H hold', 'cancel Office-14'])
  })
  it('lists no printers when CUPS has none, and says when the scheduler is down', async () => {
    expect(await printersBridge(fakeExec({ 'lpstat -l -p': { code: 1, stderr: 'lpstat: No destinations added.' } }).exec).printers()).toEqual({ available: true, value: [] })
    expect(await printersBridge(fakeExec({ 'lpstat -l -p': { code: 1, stderr: 'lpstat: Scheduler is not running.' } }).exec).printers()).toEqual({ available: false, reason: 'service_unavailable' })
  })
})
