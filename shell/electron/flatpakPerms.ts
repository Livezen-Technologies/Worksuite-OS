// App detail permissions (G09): turn one declared Flatpak permission off or back on for this user with
// `flatpak override --user`, the same mechanism Flatseal uses. Only permissions the app declares can be changed,
// and only to take them away or give back what was declared, never to grant more. Fixed argv, no shell.
import type { Exec } from './system'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
const FLATPAK_ID = /^flatpak:[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$/
const VALUE = /^[A-Za-z0-9_.~/:+-]+$/

/** "filesystems=home;xdg-download" → ["filesystems=home", "filesystems=xdg-download"]. */
export function splitPermissions(perms: string[]): string[] {
  return perms.flatMap((p) => {
    const i = p.indexOf('=')
    if (i < 0) return []
    const k = p.slice(0, i)
    return p.slice(i + 1).split(';').filter(Boolean).map((v) => `${k}=${v}`)
  })
}

/** `flatpak override --user --show <id>` → the entries this user turned off ("key=value"), from "key=!v;…" lines. */
export function parseUserOff(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([a-z-]+)=(.*)$/.exec(line)
    if (!m) continue
    for (const v of m[2].split(';')) if (v.startsWith('!')) out.push(`${m[1]}=${v.slice(1)}`)
  }
  return out
}

/** The override flag that takes one permission away (allow=false) or gives back the declared one (allow=true). */
export function overrideFlag(perm: string, allow: boolean): string | null {
  const i = perm.indexOf('=')
  if (i < 0) return null
  const k = perm.slice(0, i), v = perm.slice(i + 1)
  if (!VALUE.test(v)) return null
  const FLAGS: Record<string, [string, string]> = {
    shared: ['--share', '--unshare'], sockets: ['--socket', '--nosocket'], devices: ['--device', '--nodevice'],
    filesystems: ['--filesystem', '--nofilesystem'], features: ['--allow', '--disallow'],
  }
  const f = FLAGS[k]
  // An access suffix (":ro", ":create") is part of the grant; it is never part of the "no" form.
  return f ? `${allow ? f[0] : f[1]}=${allow ? v : v.replace(/:(ro|rw|create)$/, '')}` : null
}

export function flatpakPermsClient(exec: Exec) {
  const appId = (c: string) => (FLATPAK_ID.test(c) ? c.slice('flatpak:'.length) : null)
  return {
    async userOff(catalogId: string): Promise<Reply<string[]>> {
      const id = appId(catalogId)
      if (!id) return { ok: false, error: 'invalid_argument' }
      const r = await exec('flatpak', ['override', '--user', '--show', id])
      if (r.missing) return { ok: false, error: 'service_unavailable' }
      return r.code === 0 ? { ok: true, value: parseUserOff(r.stdout) } : { ok: true, value: [] }
    },
    /** `declared` comes from the package service's read of the app's metadata; perm must be one of them. */
    async set(catalogId: string, perm: string, allow: boolean, declared: string[]): Promise<Reply<true>> {
      const id = appId(catalogId)
      const flag = overrideFlag(perm, allow)
      if (!id || !flag || !splitPermissions(declared).includes(perm)) return { ok: false, error: 'invalid_argument' }
      const r = await exec('flatpak', ['override', '--user', flag, id])
      if (r.missing) return { ok: false, error: 'service_unavailable' }
      return r.code === 0 ? { ok: true, value: true } : { ok: false, error: r.stderr.trim().split('\n')[0] || 'failed' }
    },
  }
}
