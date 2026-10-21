// Laptop Fn keys (#62): Labwc's XF86* bindings and services/session/bin/worksuite-hotkey, run with stand-ins for
// wpctl, brightnessctl and busctl on PATH (what they print is what the real tools print).
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const HOTKEY = join(ROOT, 'services/session/bin/worksuite-hotkey')

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

/** A fake bin directory: each tool appends its argv to log and prints what `out` says. */
function sandbox(tools: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'hotkey-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  const log = join(dir, 'log')
  writeFileSync(log, '')
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const run = (arg: string, env: Record<string, string> = {}) => {
    execFileSync('/bin/sh', [HOTKEY, arg], { env: { PATH: `${bin}:/usr/bin:/bin`, WORKSUITE_BACKLIGHT_DIR: join(dir, 'backlight'), ...env } })
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  }
  return { run, dir }
}
const backlight = (root: string, name: string, type: string, cur: number, max: number) => {
  const d = join(root, 'backlight', name); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'type'), `${type}\n`); writeFileSync(join(d, 'brightness'), `${cur}\n`); writeFileSync(join(d, 'max_brightness'), `${max}\n`)
}
const OSD = 'busctl --user --timeout=1 call lk.worksuite.Shell1 /lk/worksuite/Shell1 lk.worksuite.Shell1 Osd sub'

describe('#62 Labwc binds the laptop Fn keys', () => {
  const rc = read('services/session/labwc/rc.xml')
  it.each([
    ['XF86AudioRaiseVolume', 'volume-up'], ['XF86AudioLowerVolume', 'volume-down'], ['XF86AudioMute', 'mute'], ['XF86AudioMicMute', 'mic-mute'],
    ['XF86MonBrightnessUp', 'brightness-up'], ['XF86MonBrightnessDown', 'brightness-down'], ['XF86AudioPlay', 'play-pause'],
  ])('%s → worksuite-hotkey %s, on the lock screen too', (key, action) => {
    expect(rc).toContain(`<keybind key="${key}" allowWhenLocked="yes"><action name="Execute" command="/usr/lib/worksuite/worksuite-hotkey ${action}"/></keybind>`)
  })
  it('installs the helper and the tools it runs', () => {
    expect(read('packaging/debian/worksuite-session.install')).toContain('services/session/bin/worksuite-hotkey usr/lib/worksuite/')
    const list = read('live-build/config/package-lists/worksuite.list.chroot')
    for (const p of ['brightnessctl', 'playerctl', 'wireplumber']) expect(list).toMatch(new RegExp(`^${p}$`, 'm'))
  })
})

describe('#62 worksuite-hotkey', () => {
  it('raises the volume (unmuting, capped at 100%) and shows the level', () => {
    const s = sandbox({ wpctl: 'case "$1" in get-volume) echo "Volume: 0.55";; esac', busctl: '' })
    expect(s.run('volume-up')).toEqual([
      'wpctl set-mute @DEFAULT_AUDIO_SINK@ 0', 'wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ 5%+', 'wpctl get-volume @DEFAULT_AUDIO_SINK@',
      `${OSD} volume 55 false`])
  })
  it('mute and mic mute toggle, and the indicator says muted', () => {
    let s = sandbox({ wpctl: 'case "$1" in get-volume) echo "Volume: 0.30 [MUTED]";; esac', busctl: '' })
    expect(s.run('mute')).toEqual(['wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle', 'wpctl get-volume @DEFAULT_AUDIO_SINK@', `${OSD} volume 30 true`])
    rmSync(dir, { recursive: true, force: true })
    s = sandbox({ wpctl: 'case "$1" in get-volume) echo "Volume: 1.00 [MUTED]";; esac', busctl: '' })
    expect(s.run('mic-mute')).toEqual(['wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle', 'wpctl get-volume @DEFAULT_AUDIO_SOURCE@', `${OSD} mic 100 true`])
  })
  it('brightness through brightnessctl on the firmware/platform backlight, never below 1%', () => {
    const s = sandbox({ brightnessctl: 'echo "intel_backlight,backlight,9600,50%,19200"', busctl: '' })
    backlight(s.dir, 'acpi_video0', 'firmware', 5, 10)
    backlight(s.dir, 'intel_backlight', 'raw', 9600, 19200)
    expect(s.run('brightness-down')).toEqual(['brightnessctl -m -n1 -d acpi_video0 set 5%-', `${OSD} brightness 50 false`])
  })
  it('without brightnessctl, logind sets the brightness (no root needed)', () => {
    const s = sandbox({ busctl: '' })
    backlight(s.dir, 'amdgpu_bl0', 'raw', 100, 255)
    expect(s.run('brightness-up')).toEqual([
      'busctl call org.freedesktop.login1 /org/freedesktop/login1/session/auto org.freedesktop.login1.Session SetBrightness ssu backlight amdgpu_bl0 113',
      `${OSD} brightness 44 false`])
  })
  it('does nothing without a backlight, and refuses unknown actions', () => {
    const s = sandbox({ brightnessctl: '', busctl: '' })
    expect(s.run('brightness-up')).toEqual([])
    expect(() => s.run('rm-rf')).toThrow()
  })
})
