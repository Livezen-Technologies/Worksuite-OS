import { describe, expect, it } from 'vitest'
import { bootMode, cmdlineRecovery } from './bootmode'

describe('boot mode', () => {
  it('reads the GRUB recovery flag from the kernel command line', () => {
    expect(cmdlineRecovery('BOOT_IMAGE=/vmlinuz root=UUID=x ro systemd.unit=worksuite-recovery.target worksuite.recovery=1 quiet\n')).toBe(true)
    expect(cmdlineRecovery('root=UUID=x ro quiet splash')).toBe(false)
    expect(cmdlineRecovery('worksuite.recovery=10')).toBe(false)
    expect(cmdlineRecovery('xworksuite.recovery=1')).toBe(false)
    expect(cmdlineRecovery(null)).toBe(false)
  })
  it('argv flags and cmdline pick the screen; recovery wins', () => {
    expect(bootMode(['electron', '.', '--recovery'], '')).toBe('recovery')
    expect(bootMode(['electron', '.', '--installer'], 'worksuite.recovery=1')).toBe('recovery')
    expect(bootMode(['electron', '.', '--installer'], 'quiet')).toBe('installer')
    expect(bootMode(['electron', '.', '--mode=recovery'], 'quiet')).toBe(null)
    expect(bootMode(['electron', '.', '--safe'], 'quiet')).toBe('safe')
    expect(bootMode(['electron', '.', '--safe'], 'worksuite.recovery=1')).toBe('recovery')
  })
})

describe('GNOME app modes', () => {
  it('opens WorkSuite Settings or Setup as a window, with a section a launcher may name', async () => {
    const { bootMode, controlSection } = await import('./bootmode')
    expect(bootMode(['electron', '.', '--control-center'], null)).toBe('control')
    expect(bootMode(['electron', '.', '--setup'], null)).toBe('setup')
    expect(bootMode(['electron', '.', '--control-center'], 'worksuite.recovery=1')).toBe('recovery')
    expect(controlSection(['x', '--control-center', 'Updates'])).toBe('Updates')
    expect(controlSection(['x', '--control-center', 'Date & time'])).toBe('Date & time')
    expect(controlSection(['x', '--control-center', '--setup'])).toBeNull()
    expect(controlSection(['x', '--control-center', '../../etc'])).toBeNull()
    expect(controlSection(['x', '--control-center'])).toBeNull()
  })
})
