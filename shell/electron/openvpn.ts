// OpenVPN import for Settings › Network › VPN (WSOS-INT-001). Pure: .ovpn validation, certificate extraction and the
// rewritten config handed to `nmcli connection import type openvpn` (network-manager-openvpn). Nothing here runs a
// command; system.ts does that with fixed argument arrays.
//
// Refused: every OpenVPN directive that runs a program or loads code (`up`, `down`, `route-up`, `plugin`, …) and
// `script-security` above 1 (1 = built-in executables only, OpenVPN's default). NetworkManager ignores most of these,
// so a file that depends on them would silently misbehave, and an admin-looking file must never smuggle a hook into
// a root-run daemon. Credentials in the file (`auth-user-pass <file>`, `<auth-user-pass>` blocks) are refused too:
// the shell asks for them and passes them to nmcli on stdin.

/** Directives that execute something or pull in more config. */
export const OVPN_HOOKS = new Set([
  'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'tls-verify', 'auth-user-pass-verify', 'client-connect',
  'client-disconnect', 'learn-address', 'plugin', 'config', 'tls-export-cert', 'management-client', 'iproute',
  'setenv-safe', 'cd', 'chroot', 'daemon', 'writepid', 'log', 'log-append', 'status',
])
/** Directives whose argument is a file (or an inline <block>) that is copied into the private certificate folder. */
export const OVPN_FILES = ['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'pkcs12', 'secret', 'extra-certs', 'crl-verify'] as const
export type OvpnFileDirective = typeof OVPN_FILES[number]

export interface OvpnFile { directive: OvpnFileDirective; inline: string | null; path: string | null; extra: string[] }
export interface OvpnSummary { remotes: string[]; proto: string | null; dev: string | null; needs_credentials: boolean; files: OvpnFile[] }
export type OvpnParsed = { ok: true; value: OvpnSummary; lines: string[] } | { ok: false; error: string }

const isFileDirective = (k: string): k is OvpnFileDirective => (OVPN_FILES as readonly string[]).includes(k)

/** Splits an OpenVPN config line into words, honouring "double" and 'single' quotes. */
export function ovpnWords(line: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3])
  return out
}

/**
 * .ovpn text → summary + the remaining directive lines, or the reason it can't be imported. Inline blocks
 * (<ca>…</ca>) and file references are both collected in `files`; their directive lines are dropped from `lines`
 * and re-added by renderOvpnForImport with the private copies' paths.
 */
export function parseOvpn(text: string): OvpnParsed {
  if (text.length > 256 * 1024 || text.includes('\0')) return { ok: false, error: 'invalid_file' }
  const files: OvpnFile[] = []
  const lines: string[] = []
  const remotes: string[] = []
  const inlineArgs = new Map<string, string[]>()
  let proto: string | null = null, dev: string | null = null, needsCreds = false, client = false
  const src = text.split(/\r?\n/)
  for (let i = 0; i < src.length; i++) {
    const line = src[i].trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const block = /^<([a-z-]+)>$/.exec(line)
    if (block) {
      const tag = block[1]
      const end = src.findIndex((l, j) => j > i && l.trim() === `</${tag}>`)
      if (end < 0) return { ok: false, error: 'invalid_file' }
      const body = src.slice(i + 1, end).join('\n') + '\n'
      i = end
      if (tag === 'auth-user-pass') return { ok: false, error: 'credentials_in_file' }
      if (tag === 'connection') return { ok: false, error: 'unsupported_directive' }
      if (!isFileDirective(tag)) return { ok: false, error: 'invalid_file' }
      files.push({ directive: tag, inline: body, path: null, extra: [] })
      continue
    }
    const words = ovpnWords(line.replace(/^--/, ''))
    const k = words[0].toLowerCase()
    if (!/^[a-z0-9-]+$/.test(k)) return { ok: false, error: 'invalid_file' }
    if (OVPN_HOOKS.has(k)) return { ok: false, error: 'scripts_not_supported' }
    if (k === 'script-security') {
      const level = Number(words[1])
      if (!Number.isInteger(level) || level > 1) return { ok: false, error: 'scripts_not_supported' }
      continue   // ≤ 1 is the default; NetworkManager sets its own
    }
    if (k === 'auth-user-pass') {
      if (words.length > 1) return { ok: false, error: 'credentials_in_file' }
      needsCreds = true
    }
    if (k === 'askpass' && words.length > 1) return { ok: false, error: 'credentials_in_file' }
    if (k === 'client' || k === 'tls-client' || k === 'pull') client = true
    if (k === 'remote') { if (!words[1] || !/^[A-Za-z0-9.:_-]+$/.test(words[1])) return { ok: false, error: 'invalid_remote' }; remotes.push(words.slice(1, 3).join(':')) }
    if (k === 'proto') proto = words[1] ?? null
    if (k === 'dev') dev = words[1] ?? null
    if (isFileDirective(k)) {
      const p = words[1]
      if (!p) return { ok: false, error: 'invalid_file' }
      if (p !== '[inline]') files.push({ directive: k, inline: null, path: p, extra: words.slice(2) })
      else inlineArgs.set(k, words.slice(2))   // e.g. `tls-auth [inline] 1`: the direction applies to the <tls-auth> block
      continue
    }
    lines.push(words.map((w) => (/[\s"']/.test(w) ? `"${w.replace(/["\\]/g, '\\$&')}"` : w)).join(' '))
  }
  for (const f of files) if (f.inline !== null) f.extra = inlineArgs.get(f.directive) ?? []
  if (!remotes.length) return { ok: false, error: 'invalid_remote' }
  if (!client && !files.some((f) => f.directive === 'secret')) return { ok: false, error: 'invalid_file' }
  return { ok: true, value: { remotes, proto, dev, needs_credentials: needsCreds, files }, lines }
}

/** A referenced certificate path must stay next to the .ovpn file: plain relative name, no '..', no absolute path. */
export function safeRelativeRef(p: string): boolean {
  return !!p && !p.startsWith('/') && !p.split(/[\\/]/).some((s) => s === '..' || s === '') && !/[\0\n]/.test(p)
}

/** Name of the private copy: `<directive>.pem` (pkcs12 → .p12, static/tls keys → .key). */
export function certFileName(f: OvpnFile, index: number): string {
  const ext = f.directive === 'pkcs12' ? 'p12' : f.directive === 'tls-auth' || f.directive === 'tls-crypt' || f.directive === 'secret' || f.directive === 'key' ? 'key' : 'pem'
  return `${index}-${f.directive}.${ext}`
}

/** The config nmcli imports: the kept directives plus each file directive pointing at its private copy. */
export function renderOvpnForImport(lines: string[], files: OvpnFile[], certPaths: string[]): string {
  const q = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`
  return [
    '# Imported by WorkSuite Settings; certificates live in the user\'s private VPN folder.',
    ...lines,
    ...files.map((f, i) => [f.directive, q(certPaths[i]), ...f.extra].join(' ')),
  ].join('\n') + '\n'
}

/** Connection name for an imported file: printable, at most 48 characters. */
export function ovpnConnectionName(fileName: string): string {
  const base = fileName.replace(/\.(ovpn|conf)$/i, '').replace(/[^A-Za-z0-9 _.()-]/g, '').trim().slice(0, 48)
  return base && base !== '.' && base !== '..' ? base : 'OpenVPN'
}

/** `nmcli -g vpn.data connection show …` → map. NM prints `key = value, key = value` with ',' escaped as '\,'. */
export function parseVpnData(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of text.trim().split(/(?<!\\),\s*/)) {
    const m = /^([^=]+?)\s*=\s*(.*)$/.exec(part)
    if (m) out[m[1].trim()] = m[2].replace(/\\,/g, ',').trim()
  }
  return out
}

/** OpenVPN connection types that need a user name and password at connect time. */
export function openvpnNeedsCredentials(data: Record<string, string>): boolean {
  return data['connection-type'] === 'password' || data['connection-type'] === 'password-tls'
}
