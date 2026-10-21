import { describe, expect, it } from 'vitest'
import {
  btError, cupsError, mountedAt, newDevices, parseFcitxProfile, parseInhibitors, parseJobs, parseLpinfo, parseLsblk,
  parsePowerProfiles, parsePrinterIssues, activeCaptures, peripheralsBridge, SCREENCAST_STOP, printerUri, queueName, renderFcitxProfile, udisksError, type FsDeps,
} from './peripherals'
import type { Exec, WithStdin } from './system'

function fakeExec(answers: Record<string, { code?: number; stdout?: string; stderr?: string; missing?: boolean }>) {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    const key = [cmd, ...args].join(' ')
    const hit = Object.keys(answers).find((k) => key.startsWith(k))
    const a = hit ? answers[hit] : { code: 0 }
    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '', missing: a.missing }
  }
  return { exec, calls }
}
const stdinCalls: { args: string[]; input: string }[] = []
const withStdin: WithStdin = async (cmd, args, input) => { stdinCalls.push({ args: [cmd, ...args], input }); return { code: 0, stderr: '' } }
const memFs = (files: Record<string, string> = {}): FsDeps & { files: Record<string, string> } => ({
  files, async read(p) { return files[p] ?? null }, async write(p, s) { files[p] = s },
})

const LSBLK = JSON.stringify({ blockdevices: [
  { name: 'nvme0n1', path: '/dev/nvme0n1', type: 'disk', rm: false, hotplug: false, tran: 'nvme', children: [{ path: '/dev/nvme0n1p1', fstype: 'vfat', type: 'part' }] },
  { name: 'sdb', path: '/dev/sdb', type: 'disk', rm: true, hotplug: true, tran: 'usb', size: '29.8G', children: [
    { path: '/dev/sdb1', fstype: 'vfat', label: 'KINGSTON', size: '14G', type: 'part', mountpoint: '/media/u/KINGSTON' },
    { path: '/dev/sdb2', fstype: 'crypto_LUKS', size: '15G', type: 'part', children: [{ path: '/dev/mapper/luks-1', type: 'crypt', fstype: 'ext4', label: 'secret', mountpoints: [null] }] },
  ] },
  { name: 'sdc', path: '/dev/sdc', type: 'disk', rm: '1', fstype: 'exfat', label: 'CAM', size: '64G' },
] })

describe('Bluetooth pairing (WSOS-INT-003)', () => {
  it('lists only unpaired devices and drops address-only names', () => {
    const all = 'Device AA:BB:CC:DD:EE:01 Keyboard K380\nDevice AA:BB:CC:DD:EE:02 AA-BB-CC-DD-EE-02\nDevice AA:BB:CC:DD:EE:03 Mouse'
    expect(newDevices(all, 'Device AA:BB:CC:DD:EE:03 Mouse')).toEqual([{ address: 'AA:BB:CC:DD:EE:01', name: 'Keyboard K380' }, { address: 'AA:BB:CC:DD:EE:02', name: '' }])
  })
  it('pairs, trusts and connects with fixed argv; rejects bad addresses', async () => {
    const { exec, calls } = fakeExec({})
    const b = peripheralsBridge('/home/u', exec, withStdin, memFs())
    expect(await b.btPair('AA:BB:CC:DD:EE:01')).toEqual({ available: true, value: true })
    expect(calls.map((c) => c.join(' '))).toEqual(['bluetoothctl --agent NoInputNoOutput --timeout 30 pair AA:BB:CC:DD:EE:01', 'bluetoothctl trust AA:BB:CC:DD:EE:01', 'bluetoothctl connect AA:BB:CC:DD:EE:01'])
    expect(await b.btPair('AA;rm -rf /')).toEqual({ available: false, reason: 'invalid_argument' })
    expect(await b.btRemove('AA:BB:CC:DD:EE:01')).toEqual({ available: true, value: true })
  })
  it('explains pairing failures', async () => {
    const { exec } = fakeExec({ 'bluetoothctl --agent': { code: 0, stdout: 'Failed to pair: org.bluez.Error.AuthenticationFailed' } })
    expect(await peripheralsBridge('/h', exec, withStdin, memFs()).btPair('AA:BB:CC:DD:EE:01')).toEqual({ available: false, reason: 'bt_auth_failed' })
    expect(btError('org.bluez.Error.ConnectionAttemptFailed')).toBe('bt_unreachable')
  })
})

describe('removable storage (WSOS-INT-004)', () => {
  it('lists removable volumes only, with LUKS state', () => {
    expect(parseLsblk(LSBLK)).toEqual([
      { device: '/dev/sdb1', disk: '/dev/sdb', label: 'KINGSTON', size: '14G', fstype: 'vfat', mountpoint: '/media/u/KINGSTON', encrypted: false, unlocked: null },
      { device: '/dev/sdb2', disk: '/dev/sdb', label: 'secret', size: '15G', fstype: 'ext4', mountpoint: null, encrypted: true, unlocked: '/dev/mapper/luks-1' },
      { device: '/dev/sdc', disk: '/dev/sdc', label: 'CAM', size: '64G', fstype: 'exfat', mountpoint: null, encrypted: false, unlocked: null },
    ])
    expect(parseLsblk('not json')).toEqual([])
  })
  it('unlocks with the passphrase on stdin only, then mounts the cleartext device', async () => {
    stdinCalls.length = 0
    const { exec, calls } = fakeExec({ lsblk: { stdout: LSBLK }, 'udisksctl mount': { stdout: 'Mounted /dev/dm-0 at /media/u/secret.' } })
    const r = await peripheralsBridge('/h', exec, withStdin, memFs()).unlock('/dev/sdb2', 'hunter2 pass')
    expect(r).toEqual({ available: true, value: '/media/u/secret' })
    expect(stdinCalls).toEqual([{ args: ['udisksctl', 'unlock', '--no-user-interaction', '-b', '/dev/sdb2', '--key-file', '/dev/stdin'], input: 'hunter2 pass' }])
    expect(calls.flat().join(' ')).not.toContain('hunter2')
  })
  it('safe eject unmounts every volume on the drive, locks LUKS, then powers off', async () => {
    const { exec, calls } = fakeExec({ lsblk: { stdout: LSBLK.replace('"mountpoints":[null]', '"mountpoint":"/media/u/secret"') } })
    expect(await peripheralsBridge('/h', exec, withStdin, memFs()).eject('/dev/sdb1')).toEqual({ available: true, value: true })
    expect(calls.slice(1).map((c) => c.join(' '))).toEqual([
      'udisksctl unmount --no-user-interaction -b /dev/sdb1', 'udisksctl unmount --no-user-interaction -b /dev/mapper/luks-1',
      'udisksctl lock --no-user-interaction -b /dev/sdb2', 'udisksctl power-off --no-user-interaction -b /dev/sdb',
    ])
  })
  it('gives clear errors', async () => {
    expect(udisksError('Error unmounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: target is busy')).toBe('storage_busy')
    expect(udisksError('Error unlocking /dev/sdb2: Failed to activate device: Operation not permitted')).toBe('bad_passphrase')
    expect(udisksError('GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorizedCanObtain')).toBe('not_authorized')
    expect(mountedAt('Mounted /dev/sdb1 at /media/u/USB.\n')).toBe('/media/u/USB')
    const { exec } = fakeExec({})
    expect(await peripheralsBridge('/h', exec, withStdin, memFs()).mount('/dev/sdb1; reboot')).toEqual({ available: false, reason: 'invalid_argument' })
  })
})

describe('power (WSOS-INT-005)', () => {
  it('parses power profiles and inhibitors', () => {
    expect(parsePowerProfiles('  performance:\n    CpuDriver:\tintel_pstate\n    Degraded:   yes (high-operating-temperature)\n\n* balanced:\n    CpuDriver:\tintel_pstate\n\n  power-saver:\n    CpuDriver:\tintel_pstate\n'))
      .toEqual({ active: 'balanced', profiles: ['performance', 'balanced', 'power-saver'], degraded: 'high-operating-temperature' })
    expect(parsePowerProfiles('')).toBeNull()
    expect(parseInhibitors('{"type":"a(ssssuu)","data":[[["sleep","Firefox","Playing video","block",1000,42],["shutdown","NetworkManager","","delay",0,1]]]}'))
      .toEqual([{ what: 'sleep', who: 'Firefox', why: 'Playing video', mode: 'block' }, { what: 'shutdown', who: 'NetworkManager', why: '', mode: 'delay' }])
  })
  it('only sets known profiles', async () => {
    const { exec, calls } = fakeExec({})
    const b = peripheralsBridge('/h', exec, withStdin, memFs())
    expect(await b.setPowerProfile('performance')).toEqual({ available: true, value: true })
    expect(await b.setPowerProfile('turbo')).toEqual({ available: false, reason: 'invalid_argument' })
    expect(calls).toEqual([['powerprofilesctl', 'set', 'performance']])
    const missing = fakeExec({ powerprofilesctl: { code: 1, missing: true } })
    expect(await peripheralsBridge('/h', missing.exec, withStdin, memFs()).powerProfiles()).toEqual({ available: false, reason: 'powerprofilesctl_missing' })
  })
})

describe('printing (WSOS-INT-006)', () => {
  it('finds driverless printers and builds safe queue names', () => {
    expect(parseLpinfo('network dnssd://HP%20LaserJet%20M110._ipp._tcp.local/?uuid=1\nnetwork socket\nnetwork ipps://10.0.0.5/ipp/print\nfile cups-pdf:/'))
      .toEqual([{ uri: 'dnssd://HP%20LaserJet%20M110._ipp._tcp.local/?uuid=1', name: 'HP LaserJet M110', kind: 'network' }, { uri: 'ipps://10.0.0.5/ipp/print', name: '10.0.0.5', kind: 'network' }])
    expect(queueName('HP LaserJet M110 / 2nd floor')).toBe('HP_LaserJet_M110_2nd_floor')
    expect(printerUri('ipp://printer.local/ipp/print')).toBe('ipp://printer.local/ipp/print')
    expect(printerUri('file:///etc/shadow')).toBeNull()
    expect(printerUri('ipp://user:pw@host/')).toBeNull()
  })
  it('adds an IPP Everywhere queue with fixed argv and explains failures', async () => {
    const { exec, calls } = fakeExec({})
    expect(await peripheralsBridge('/h', exec, withStdin, memFs()).addPrinter('ipp://10.0.0.5/ipp/print', 'Office printer')).toEqual({ available: true, value: 'Office_printer' })
    expect(calls).toEqual([['lpadmin', '-p', 'Office_printer', '-E', '-v', 'ipp://10.0.0.5/ipp/print', '-m', 'everywhere', '-D', 'Office printer']])
    expect(cupsError('lpadmin: Unable to connect to "10.0.0.5:631": No route to host')).toBe('printer_unreachable')
    expect(cupsError('lpadmin: Forbidden')).toBe('not_authorized')
  })
  it('reads jobs and printer problems', () => {
    expect(parseJobs('Office-12  alice  20480  Tue 13 Oct 2026\n')).toEqual([{ id: 'Office-12', printer: 'Office', user: 'alice', size: '20480' }])
    expect(parsePrinterIssues('printer Office disabled since Tue -\n\tPaper jam\n\tAlerts: media-jam-error\nprinter Lab is idle.  enabled since x\n\tAlerts: none\n'))
      .toEqual([{ name: 'Office', reason: 'Paper jam' }])
  })
})

describe('input methods (WSOS-INT-011)', () => {
  it('round-trips a fcitx5 profile and always keeps the US keyboard', () => {
    const text = renderFcitxProfile(['m17n_si_wijesekera', 'm17n_ta_tamil99'])
    expect(parseFcitxProfile(text)).toEqual(['keyboard-us', 'm17n_si_wijesekera', 'm17n_ta_tamil99'])
    expect(text).toContain('DefaultIM=m17n_si_wijesekera')
    // A profile saved by an earlier image with the misspelled Sinhala keyboard name loads as the real one.
    expect(parseFcitxProfile('[Groups/0/Items/0]\nName=m17n_si_wijesekara\n')).toEqual(['m17n_si_wijesekera'])
  })
  it('writes the user profile, refuses unknown ids, and reloads fcitx5', async () => {
    const fs = memFs({ '/etc/xdg/fcitx5/profile': renderFcitxProfile([]) })
    const { exec, calls } = fakeExec({})
    const b = peripheralsBridge('/home/u', exec, withStdin, fs)
    expect(await b.inputMethods()).toMatchObject({ available: true, value: { enabled: ['keyboard-us'] } })
    expect(await b.setInputMethods(['m17n_ta_tamil99'])).toEqual({ available: true, value: true })
    expect(parseFcitxProfile(fs.files['/home/u/.config/fcitx5/profile'])).toEqual(['keyboard-us', 'm17n_ta_tamil99'])
    expect(calls).toEqual([['fcitx5-remote', '-r']])
    expect(await b.setInputMethods(['../../evil'])).toEqual({ available: false, reason: 'invalid_argument' })
  })
})

describe('screen capture indicator (WSOS-INT-013)', () => {
  it('counts running portal screen-capture streams only', () => {
    const node = (name: string, state: string, cls = 'Video/Source') => ({ type: 'PipeWire:Interface:Node', info: { state, props: { 'node.name': name, 'media.class': cls } } })
    expect(activeCaptures(JSON.stringify([node('xdpw_stream', 'running'), node('xdpw_stream', 'suspended'), node('alsa_output', 'running', 'Audio/Sink'), { type: 'PipeWire:Interface:Link' }]))).toBe(1)
    expect(activeCaptures('garbage')).toBe(0)
  })
  it('emergency stop runs worksuite-screencast-stop and reports the streams ended (SRS §7.1)', async () => {
    const f = fakeExec({ [SCREENCAST_STOP]: { stdout: '2\n' } })
    expect(await peripheralsBridge('/h', f.exec, withStdin, memFs()).stopScreenCapture()).toEqual({ available: true, value: 2 })
    expect(f.calls).toEqual([[SCREENCAST_STOP]])
    const gone = fakeExec({ [SCREENCAST_STOP]: { code: 1, missing: true } })
    expect(await peripheralsBridge('/h', gone.exec, withStdin, memFs()).stopScreenCapture()).toEqual({ available: false, reason: 'worksuite-screencast-stop_missing' })
  })
})

describe('taskbar input-method switcher (#58)', () => {
  const sinhala = () => memFs({ '/etc/xdg/fcitx5/profile': renderFcitxProfile(['m17n_si_wijesekera', 'm17n_ta_tamil99']) })
  it('reports the enabled methods and the active one; a stopped fcitx5 is "not running", not an error', async () => {
    let f = fakeExec({ 'fcitx5-remote -n': { stdout: 'm17n_si_wijesekera\n' } })
    expect(await peripheralsBridge('/h', f.exec, withStdin, sinhala()).imStatus())
      .toEqual({ available: true, value: { running: true, current: 'm17n_si_wijesekera', enabled: ['keyboard-us', 'm17n_si_wijesekera', 'm17n_ta_tamil99'] } })
    // What fcitx5-remote does on the tester's laptop when fcitx5 is not running: exit 1, nothing on stdout.
    f = fakeExec({ 'fcitx5-remote -n': { code: 1 } })
    expect(await peripheralsBridge('/h', f.exec, withStdin, sinhala()).imStatus()).toMatchObject({ available: true, value: { running: false, current: null } })
    f = fakeExec({ 'fcitx5-remote': { code: 1, missing: true } })
    expect(await peripheralsBridge('/h', f.exec, withStdin, sinhala()).imStatus()).toEqual({ available: false, reason: 'fcitx5_missing' })
  })
  it('switches to Sinhala with fcitx5-remote -s and answers with what fcitx5 reports afterwards', async () => {
    let now = 'keyboard-us'
    const calls: string[][] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args[0] === '-s') now = args[1]
      return { code: 0, stdout: args[0] === '-n' ? `${now}\n` : '', stderr: '' }
    }
    const b = peripheralsBridge('/h', exec, withStdin, sinhala(), async () => undefined)
    expect(await b.setCurrentIm('m17n_si_wijesekera')).toEqual({ available: true, value: 'm17n_si_wijesekera' })
    expect(calls).toContainEqual(['fcitx5-remote', '-s', 'm17n_si_wijesekera'])
    // Not enabled in Settings, or not a known method: refused before fcitx5 is asked.
    calls.length = 0
    expect(await b.setCurrentIm('m17n_ta_phonetic')).toEqual({ available: false, reason: 'im_not_enabled' })
    expect(await b.setCurrentIm('x; rm -rf ~')).toEqual({ available: false, reason: 'invalid_argument' })
    expect(calls).toEqual([])
  })
  it('starts the session fcitx5 when it is not running, then switches', async () => {
    let running = false; let now = 'keyboard-us'
    const calls: string[][] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'systemctl') { running = true; return { code: 0, stdout: '', stderr: '' } }
      if (!running) return { code: 1, stdout: '', stderr: '' }
      if (args[0] === '-s') now = args[1]
      return { code: 0, stdout: args[0] === '-n' ? `${now}\n` : '', stderr: '' }
    }
    const b = peripheralsBridge('/h', exec, withStdin, sinhala(), async () => undefined)
    expect(await b.setCurrentIm('m17n_ta_tamil99')).toEqual({ available: true, value: 'm17n_ta_tamil99' })
    expect(calls).toContainEqual(['systemctl', '--user', 'start', 'worksuite-input-method.service'])
  })
  it('says so when fcitx5 does not start or ignores the switch', async () => {
    const dead = fakeExec({ 'fcitx5-remote': { code: 1 } })
    expect(await peripheralsBridge('/h', dead.exec, withStdin, sinhala(), async () => undefined).setCurrentIm('m17n_si_wijesekera')).toEqual({ available: false, reason: 'im_not_running' })
    const stuck = fakeExec({ 'fcitx5-remote -n': { stdout: 'keyboard-us\n' } })
    expect(await peripheralsBridge('/h', stuck.exec, withStdin, sinhala(), async () => undefined).setCurrentIm('m17n_si_wijesekera')).toEqual({ available: false, reason: 'im_not_applied' })
  })
})
