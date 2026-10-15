import { describe, expect, it } from 'vitest'
import { localUsers, parseUsers } from './users'

describe('local users', () => {
  it('keeps people and marks admins', () => {
    const passwd = 'root:x:0:0:root:/root:/bin/bash\nhasa:x:1000:1000:Hasarinda Perera,,,:/home/hasa:/bin/bash\nsvc:x:1001:1001::/:/usr/sbin/nologin\nkim:x:1002:1002::/home/kim:/bin/zsh\n'
    expect(parseUsers(passwd, 'sudo:x:27:hasa\n')).toEqual([
      { login: 'hasa', uid: 1000, name: 'Hasarinda Perera', admin: true },
      { login: 'kim', uid: 1002, name: 'kim', admin: false },
    ])
  })
  it('is unavailable without /etc/passwd', () => {
    expect(localUsers('/nonexistent-root')).toEqual({ available: false, reason: 'service_unavailable' })
  })
})
