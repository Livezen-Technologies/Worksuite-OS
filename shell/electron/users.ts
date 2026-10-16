// Settings › Users: people with accounts on this computer, from /etc/passwd and /etc/group (read-only).
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface LocalUser { login: string; name: string; uid: number; admin: boolean }
type Avail<T> = { available: true; value: T } | { available: false; reason: string }

/** uid 1000–59999 with a login shell; admin = member of sudo, wheel or admin. */
export function parseUsers(passwd: string, group: string): LocalUser[] {
  const admins = new Set(group.split('\n').filter((l) => /^(sudo|wheel|admin):/.test(l)).flatMap((l) => (l.split(':')[3] ?? '').split(',').filter(Boolean)))
  return passwd.split('\n').map((l) => l.split(':')).filter((f) => f.length >= 7)
    .map((f) => ({ login: f[0], uid: Number(f[2]), name: (f[4] ?? '').split(',')[0] || f[0], shell: f[6] }))
    .filter((u) => u.uid >= 1000 && u.uid < 60000 && !/(nologin|false)$/.test(u.shell))
    .map(({ login, uid, name }) => ({ login, uid, name, admin: admins.has(login) }))
}

export function localUsers(root = '/'): Avail<{ current: string; users: LocalUser[] }> {
  const read = (p: string) => { try { return readFileSync(path.join(root, p), 'utf8') } catch { return null } }
  const passwd = read('etc/passwd')
  if (!passwd) return { available: false, reason: 'service_unavailable' }
  return { available: true, value: { current: os.userInfo().username, users: parseUsers(passwd, read('etc/group') ?? '') } }
}

/**
 * Lock screen unlock: checks the password of the signed-in user only, through pam_unix's setgid helper
 * (unix_chkpwd checks the caller's own account and nobody else's). The password goes on stdin, never argv.
 */
export function checkOwnPassword(user: string, password: string, helper = '/usr/sbin/unix_chkpwd',
  run: (cmd: string, args: string[]) => ChildProcess = (c, a) => spawn(c, a, { stdio: ['pipe', 'ignore', 'ignore'] })): Promise<{ ok: boolean; message?: string }> {
  const me = os.userInfo().username
  const login = user.replace(/^.*\\/, '').replace(/@.*$/, '')
  if (!password) return Promise.resolve({ ok: false, message: 'Enter your password.' })
  if (login && login !== me) return Promise.resolve({ ok: false, message: 'Only the signed-in user can unlock this session.' })
  return new Promise((resolve) => {
    let p: ChildProcess
    try { p = run(helper, [me, 'nonull']) } catch { resolve({ ok: false }); return }
    p.on('error', () => resolve({ ok: false }))
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false }))
    p.stdin?.on('error', () => {})
    p.stdin?.end(Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])]))
  })
}
