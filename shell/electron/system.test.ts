import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseBtDevices, parseUsers, parseVolume, parseWifi, systemInfo } from './system'

describe('system facts', () => {
  it('parseUsers keeps people and marks admins', () => {
    const passwd = 'root:x:0:0:root:/root:/bin/bash\nhasa:x:1000:1000:Hasarinda Perera,,,:/home/hasa:/bin/bash\nsvc:x:1001:1001::/:/usr/sbin/nologin\nkim:x:1002:1002::/home/kim:/bin/zsh\n'
    expect(parseUsers(passwd, 'sudo:x:27:hasa\n')).toEqual([
      { login: 'hasa', uid: 1000, name: 'Hasarinda Perera', admin: true },
      { login: 'kim', uid: 1002, name: 'kim', admin: false },
    ])
  })
  it('parseWifi dedupes SSIDs and puts the active one first', () => {
    const out = 'no:Guest:40:\nyes:Corp\\:5G:70:WPA2\nno:Corp\\:5G:90:WPA2\nno::80:WPA2\nno:Guest:60:--\n'
    expect(parseWifi(out)).toEqual([
      { active: true, ssid: 'Corp:5G', signal: 70, secure: true },
      { active: false, ssid: 'Guest', signal: 60, secure: false },
    ])
  })
  it('parseBtDevices and parseVolume', () => {
    expect(parseBtDevices('Device AA:BB:CC:DD:EE:FF My Keys\ngarbage')).toEqual([{ address: 'AA:BB:CC:DD:EE:FF', name: 'My Keys', connected: null }])
    expect(parseVolume('Volume: 0.40 [MUTED]\n')).toEqual({ volume: 40, muted: true })
    expect(parseVolume(null)).toBeNull()
  })
  it('reads displays and backlight from sysfs, and reports missing tools as unavailable', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ws-sys-'))
    const put = (rel: string, v: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), v) }
    put('sys/class/drm/card0-eDP-1/status', 'connected\n'); put('sys/class/drm/card0-eDP-1/modes', '1920x1200\n1600x1200\n')
    put('sys/class/drm/card0-HDMI-A-1/status', 'disconnected\n')
    put('sys/class/backlight/intel_backlight/brightness', '300'); put('sys/class/backlight/intel_backlight/max_brightness', '400')
    const s = systemInfo(root, async () => null)
    expect(s.displays()).toEqual({ ok: true, value: { outputs: [{ name: 'eDP-1', built_in: true, mode: '1920x1200' }], brightness: 75 } })
    expect(await s.sound()).toEqual({ ok: false, error: 'unavailable' })
    expect(await s.bluetooth()).toEqual({ ok: true, value: { adapter: false, powered: null, name: null, paired: null } })
    expect((await s.network())).toEqual({ ok: true, value: { interfaces: [], wifi: null, wifi_enabled: null } })
    expect(s.users()).toEqual({ ok: false, error: 'unavailable' })
  })
})
