import { describe, expect, it } from 'vitest'
import { localToEpochUs, parseTimedatectl, peripheralsBridge, timedateError } from './peripherals'

const SHOW = 'Timezone=Asia/Colombo\nLocalRTC=no\nCanNTP=yes\nNTP=yes\nNTPSynchronized=no\nTimeUSec=Thu 2026-11-12 11:30:00 +0530\nRTCTimeUSec=n/a\n'

describe('date & time bridge (timedatectl)', () => {
  it('parses timedatectl show', () => {
    expect(parseTimedatectl(SHOW)).toMatchObject({ timezone: 'Asia/Colombo', ntp: true, canNtp: true, synchronized: false, localRtc: false })
    // The time is the system clock now, never 1970 from the formatted TimeUSec.
    expect(Math.abs(parseTimedatectl(SHOW)!.nowUs / 1000 - Date.now())).toBeLessThan(5000)
    expect(parseTimedatectl('garbage')).toBeNull()
  })
  it('runs fixed timedatectl commands and refuses odd input before running anything', async () => {
    const calls: string[][] = []
    const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: args[0] === 'show' ? SHOW : 'Asia/Colombo\nEurope/London\nUTC\nbad zone\n', stderr: '' } }
    const b = peripheralsBridge('/home/u', exec as never)
    expect(await b.timezones()).toEqual({ available: true, value: ['Asia/Colombo', 'Europe/London', 'UTC'] })
    expect(await b.setTimezone('Europe/London')).toEqual({ available: true, value: true })
    expect(await b.setNtp('false')).toEqual({ available: true, value: true })
    expect(await b.setTime('2026-11-12 09:05', 'Asia/Colombo')).toEqual({ available: true, value: true })
    // timedated over D-Bus with interactive polkit (timedatectl without a terminal is refused without a prompt).
    const bus = ['busctl', '--system', '--allow-interactive-authorization=yes', '--timeout=300', 'call', 'org.freedesktop.timedate1', '/org/freedesktop/timedate1', 'org.freedesktop.timedate1']
    expect(calls.slice(-3)).toEqual([[...bus, 'SetTimezone', 'sb', 'Europe/London', 'true'], [...bus, 'SetNTP', 'bb', 'false', 'true'],
      [...bus, 'SetTime', 'xbb', String(Date.UTC(2026, 10, 12, 3, 35) * 1000), 'false', 'true']])
    const n = calls.length
    for (const bad of ['../../etc/passwd', 'Europe/London; reboot', '-h']) expect((await b.setTimezone(bad)).available).toBe(false)
    expect((await b.setNtp('yes')).available).toBe(false)
    for (const bad of ['2026-13-01 10:00', 'now', '2026-11-12 25:00']) expect((await b.setTime(bad)).available).toBe(false)
    expect(calls.length).toBe(n)
  })
  it('turns a wall-clock time in a zone into epoch microseconds (DST included)', () => {
    expect(localToEpochUs('2026-11-12 09:05', 'Asia/Colombo')).toBe(Date.UTC(2026, 10, 12, 3, 35) * 1000)
    expect(localToEpochUs('2026-07-01 12:00:30', 'Europe/London')).toBe(Date.UTC(2026, 6, 1, 11, 0, 30) * 1000)
    expect(localToEpochUs('2026-01-01 12:00', 'Europe/London')).toBe(Date.UTC(2026, 0, 1, 12, 0) * 1000)
    expect(localToEpochUs('nope', 'UTC')).toBeNull()
  })
  it('maps timedated refusals', () => {
    expect(timedateError('Failed to set time: Interactive authentication required.')).toBe('not_authorized')
    expect(timedateError('Failed to set time: Automatic time synchronization is enabled')).toBe('ntp_on')
    expect(timedateError('Failed to set time zone: Invalid or not installed time zone \'X\'')).toBe('invalid_argument')
  })
})
