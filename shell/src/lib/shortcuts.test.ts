// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindable, conflicts, extractShortcutsBlock, keyCaps, keyFromEvent, mergeShortcutsBlock, normalizeKey, reserved, shortcutPrefsFrom, shortcutsBlock, SYSTEM_SHORTCUTS, usedBy, type ShortcutPrefs } from './shortcuts'
import { carryDesktops, labwcTouchBlock, mergeRcXml, DEFAULT_TOUCH } from '../../electron/touch'

const RC = readFileSync(path.join(__dirname, '../../../services/session/labwc/rc.xml'), 'utf8')
const bindsOf = (rc: string, key: string) => [...rc.matchAll(/<keybind key="([^"]+)"([^>]*)>([\s\S]*?)<\/keybind>/g)].filter((m) => m[1] === key).map((m) => ({ attrs: m[2], body: m[3] }))
const ev = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}, key = '') => ({ code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

describe('system shortcut catalog', () => {
  it('matches the bindings in services/session/labwc/rc.xml exactly', () => {
    for (const s of SYSTEM_SHORTCUTS) {
      if (!s.action || s.display) continue
      for (const k of s.keys) {
        const found = bindsOf(RC, k)
        expect(found, `${s.id}: ${k}`).toHaveLength(1)
        expect(found[0].body.trim(), `${s.id}: ${k}`).toBe(s.action)
        if (s.onRelease) expect(found[0].attrs).toContain('onRelease="yes"')
      }
    }
  })

  it('has Windows 11 keys for the main actions, with no two system shortcuts on the same keys', () => {
    const want: Record<string, string> = { start: 'Super_L', ai: 'W-a', lock: 'W-l', files: 'W-e', settings: 'W-i', taskview: 'W-Tab', desktop: 'W-d', snip: 'W-S-s', history: 'W-v',
      emoji: 'W-period', switch: 'A-Tab', close: 'A-F4', monitor: 'C-S-Escape', security: 'C-A-Delete', newDesktop: 'C-W-d', closeDesktop: 'C-W-F4', print: 'Print', printWindow: 'A-Print', printSave: 'W-Print', help: 'W-slash' }
    for (const [id, k] of Object.entries(want)) expect(SYSTEM_SHORTCUTS.find((s) => s.id === id)?.keys[0], id).toBe(k)
    expect([...conflicts(undefined).keys()]).toEqual([])
  })
})

describe('keys', () => {
  it('normalizes, shows and reads key presses', () => {
    expect(normalizeKey('S-W-S')).toBe('S-W-s')
    expect(normalizeKey('W-C-d')).toBe('C-W-d')
    expect(keyCaps('W-S-s')).toEqual(['Super', 'Shift', 'S'])
    expect(keyCaps('C-A-Delete')).toEqual(['Ctrl', 'Alt', 'Del'])
    expect(keyCaps('W-period')).toEqual(['Super', '.'])
    expect(keyCaps('Print')).toEqual(['Print Screen'])
    expect(keyFromEvent(ev('KeyS', { metaKey: true, shiftKey: true }, 'S'))).toBe('S-W-s')
    expect(keyFromEvent(ev('Digit1', { shiftKey: true, ctrlKey: true }, '!'))).toBe('C-S-1')
    expect(keyFromEvent(ev('Slash', { metaKey: true }))).toBe('W-slash')
    expect(keyFromEvent(ev('PrintScreen', {}, 'PrintScreen'))).toBe('Print')
    expect(keyFromEvent(ev('ShiftLeft', { shiftKey: true }, 'Shift'))).toBeNull()
  })

  it('needs a modifier (not Shift alone) and never offers the keys the shell sends itself', () => {
    expect(bindable('a')).toBe(false)
    expect(bindable('S-a')).toBe(false)
    expect(bindable('C-a')).toBe(true)
    expect(bindable('Print')).toBe(true)
    expect(bindable('F5')).toBe(true)
    expect(reserved('C-A-W-F23')).toBe(true)
    expect(reserved('W-A-C-F1')).toBe(true)
    expect(reserved('C-A-t')).toBe(false)
  })
})

describe('user changes', () => {
  const prefs: ShortcutPrefs = {
    keys: { snip: 'W-S-x', notifications: '' },
    custom: [{ id: 'c1', name: 'Calculator', key: 'W-k', app: 'org.gnome.Calculator' }, { id: 'c2', name: 'Note', key: 'C-A-n', command: 'foot -e sh -c "echo <hi> & bye"' }],
  }

  it('validates untrusted preferences', () => {
    expect(shortcutPrefsFrom({ keys: { snip: 'W-S-x', start: 'W-q', bogus: 'W-z', lock: 'C-A-W-F23' }, custom: [{ id: 'x', key: 'W-k', name: 'n\u0007ame' }, { id: 'y', key: 'W-j', command: 'ls\nrm' }, { id: 'z', key: 'W-h', app: 'ok.app', name: 'Z' }] }))
      .toEqual({ keys: { snip: 'S-W-x' }, custom: [{ id: 'z', name: 'Z', key: 'W-h', app: 'ok.app' }] })
    expect(shortcutPrefsFrom(null)).toBeUndefined()
    expect(shortcutPrefsFrom({ keys: {} })).toBeUndefined()
  })

  it('detects conflicts with system and other custom shortcuts', () => {
    const p: ShortcutPrefs = { keys: { snip: 'W-e' }, custom: [{ id: 'a', name: 'A', key: 'W-v', command: 'x' }, { id: 'b', name: 'B', key: 'W-k', command: 'y' }, { id: 'c', name: 'C', key: 'W-K', command: 'z' }, { id: 'd', name: 'D', key: 'W-3', command: 'w' }] }
    const c = conflicts(p)
    expect(c.get('W-e')).toEqual([{ kind: 'system', id: 'files' }, { kind: 'system', id: 'snip' }])
    expect(c.get('W-v')).toEqual([{ kind: 'system', id: 'history' }, { kind: 'custom', id: 'a' }])
    expect(c.get('W-k')).toEqual([{ kind: 'custom', id: 'b' }, { kind: 'custom', id: 'c' }])
    expect(c.get('W-3')).toEqual([{ kind: 'system', id: 'goto' }, { kind: 'custom', id: 'd' }])
    expect(usedBy(p, 'w-E', { kind: 'system', id: 'snip' })).toEqual([{ kind: 'system', id: 'files' }])
    expect(usedBy(undefined, 'C-c')).toEqual([{ kind: 'system', id: 'copy' }])
  })

  it('writes a block that removes moved or disabled bindings and adds the new ones, escaped', () => {
    const b = shortcutsBlock(prefs)
    expect(b).toContain('<keybind key="W-S-s"><action name="None"/></keybind>')
    expect(b).toContain('<keybind key="S-Print"><action name="None"/></keybind>')
    expect(b).toContain('<keybind key="S-W-x"><action name="Execute" command="worksuite-screenshot --snip"/></keybind>')
    expect(b).toContain('<keybind key="W-n"><action name="None"/></keybind>')
    expect(b).toContain('lk.worksuite.Shell1 Open s app:org.gnome.Calculator')
    expect(b).toContain('command="foot -e sh -c &quot;echo &lt;hi&gt; &amp; bye&quot;"')
    expect(shortcutsBlock(undefined).split('\n')).toHaveLength(2)
  })

  it('round-trips through rc.xml: inside <keyboard>, replaced not duplicated, valid XML', () => {
    const rc = mergeShortcutsBlock(RC, shortcutsBlock(prefs))
    const again = mergeShortcutsBlock(rc, shortcutsBlock(prefs))
    expect(again).toBe(rc)
    expect(rc.indexOf('worksuite-shortcuts:begin')).toBeLessThan(rc.indexOf('</keyboard>'))
    expect(rc.indexOf('worksuite-shortcuts:begin')).toBeGreaterThan(rc.indexOf('<keyboard>'))
    expect(extractShortcutsBlock(rc)).toBe(shortcutsBlock(prefs))
    expect(mergeShortcutsBlock(rc, null)).toBe(RC)
    expect(new DOMParser().parseFromString(rc, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0)
    // the block's None comes after the system binding, so it wins in Labwc
    expect(rc.indexOf('<keybind key="W-n"><action name="None"/>')).toBeGreaterThan(rc.indexOf('<keybind key="W-n"><action name="Execute"'))
  })

  it('survives the touchscreen writer, which rebuilds rc.xml from the system file', () => {
    const user = mergeShortcutsBlock(RC.replace(/<desktops[\s\S]*?<\/desktops>/, '<desktops number="2"><popupTime>0</popupTime><names><name>A</name><name>B</name></names></desktops>'), shortcutsBlock(prefs))
    const rebuilt = carryDesktops(user, mergeRcXml(RC, labwcTouchBlock(DEFAULT_TOUCH, [])))
    expect(extractShortcutsBlock(rebuilt)).toBe(shortcutsBlock(prefs))
    expect(rebuilt).toContain('<name>B</name>')
    expect(rebuilt.match(/worksuite-shortcuts:begin/g)).toHaveLength(1)
  })
})
