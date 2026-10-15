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
  })
})
