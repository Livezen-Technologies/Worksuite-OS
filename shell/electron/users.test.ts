import { describe, expect, it } from 'vitest'
import { checkOwnPassword, localUsers, parseUsers } from './users'

describe('local users', () => {
  it('keeps people and marks admins', () => {
    const passwd = 'root:x:0:0:root:/root:/bin/bash\nhasa:x:1000:1000:Test Person,,,:/home/hasa:/bin/bash\nsvc:x:1001:1001::/:/usr/sbin/nologin\nkim:x:1002:1002::/home/kim:/bin/zsh\n'
    expect(parseUsers(passwd, 'sudo:x:27:hasa\n')).toEqual([
      { login: 'hasa', uid: 1000, name: 'Test Person', admin: true },
      { login: 'kim', uid: 1002, name: 'kim', admin: false },
    ])
  })
  it('is unavailable without /etc/passwd', () => {
    expect(localUsers('/nonexistent-root')).toEqual({ available: false, reason: 'service_unavailable' })
  })
})

describe('checkOwnPassword', () => {
  const fake = (code: number, seen: Buffer[]) => (() => {
    const { EventEmitter } = require('node:events') as typeof import('node:events')
    const p: any = new EventEmitter()
    p.stdin = { on() {}, end(b: Buffer) { seen.push(b); setImmediate(() => p.emit('close', code)) } }
    return p
  })
  it('passes the password on stdin, NUL-terminated, and accepts exit 0', async () => {
    const seen: Buffer[] = []
    const me = require('node:os').userInfo().username
    expect(await checkOwnPassword(me, 'pw', '/x', fake(0, seen) as any)).toEqual({ ok: true })
    expect(seen[0].toString()).toBe('pw\0')
  })
  it('rejects a wrong password and another account', async () => {
    const me = require('node:os').userInfo().username
    expect((await checkOwnPassword(me, 'pw', '/x', fake(7, []) as any)).ok).toBe(false)
    expect((await checkOwnPassword('someone-else-xyz', 'pw', '/x', fake(0, []) as any)).ok).toBe(false)
  })
})
