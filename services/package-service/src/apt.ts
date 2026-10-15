// Parsers and checks for APT/dpkg output and sources (SRS §6.2). Pure functions; no I/O.

export interface Change { name: string; version: string }
export interface Plan { install: Change[]; upgrade: Change[]; remove: Change[] }

/**
 * `apt-get -s` lines: "Inst pkg [old] (new suite [arch])", "Remv pkg [ver]". An Inst with a [old] version is an upgrade.
 */
export function parseSimulation(out: string): Plan {
  const plan: Plan = { install: [], upgrade: [], remove: [] };
  for (const line of out.split('\n')) {
    let m = /^Inst (\S+) (?:\[([^\]]+)\] )?\((\S+)/.exec(line);
    if (m) { (m[2] ? plan.upgrade : plan.install).push({ name: m[1], version: m[3] }); continue; }
    m = /^Remv (\S+)(?: \[([^\]]+)\])?/.exec(line);
    if (m) plan.remove.push({ name: m[1], version: m[2] ?? '' });
  }
  return plan;
}

const UNITS: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9 };
/** "After this operation, 12.3 MB of additional disk space will be used." / "... 4 kB disk space will be freed." → signed bytes. */
export function parseDiskChange(out: string): number | null {
  const m = /After this operation, ([\d.,]+) (B|kB|MB|GB) (?:of additional )?disk space will be (used|freed)/.exec(out);
  if (!m) return null;
  const bytes = Math.round(Number(m[1].replace(/,/g, '')) * UNITS[m[2]]);
  return m[3] === 'freed' ? -bytes : bytes;
}

/** `apt list --upgradable` → names and new versions. */
export function parseUpgradable(out: string): Change[] {
  return out.split('\n').map((l) => /^([^/\s]+)\/\S+ (\S+) /.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ name: m[1], version: m[2] }));
}

/** WSOS-APT-001/002: Debian trixie + the signed WorkSuite repository, each with Signed-By; never testing/unstable. */
export const ALLOWED_HOSTS = ['deb.debian.org', 'security.debian.org', 'download.worksuitecloud.com'];
const BAD_SUITES = /^(testing|unstable|sid|experimental|forky)(-|$)/;
const OK_SUITES = /^trixie(-updates|-security|-backports|-dev|-pilot|-stable)?$/;

export function checkSources(text: string, file: string): string[] {
  const issues: string[] = [];
  // deb822 (.sources) stanzas
  if (file.endsWith('.sources')) {
    for (const stanza of text.split(/\n\s*\n/)) {
      const f = Object.fromEntries(stanza.split('\n').map((l) => /^([A-Za-z-]+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m![1].toLowerCase(), m![2].trim()]));
      if (!f.uris) continue;
      if ((f.enabled ?? 'yes').toLowerCase() === 'no') continue;
      checkEntry(f.uris.split(/\s+/), (f.suites ?? '').split(/\s+/), !!f['signed-by'], file, issues);
    }
    return issues;
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!/^deb(-src)?\s/.test(line)) continue;
    const opts = /\[([^\]]*)\]/.exec(line)?.[1] ?? '';
    const rest = line.replace(/\[[^\]]*\]/, '').split(/\s+/).slice(1);
    checkEntry([rest[0]], [rest[1]], /signed-by=/.test(opts), file, issues);
  }
  return issues;
}

function checkEntry(uris: string[], suites: string[], signedBy: boolean, file: string, issues: string[]) {
  for (const uri of uris) {
    let host = '';
    try { host = new URL(uri).host; } catch { issues.push(`${file}: bad URI ${uri}`); continue; }
    if (!ALLOWED_HOSTS.includes(host)) issues.push(`${file}: repository ${host} is not an approved source`);
  }
  for (const s of suites) {
    if (BAD_SUITES.test(s)) issues.push(`${file}: suite ${s} is not allowed (testing/unstable)`);
    else if (!OK_SUITES.test(s)) issues.push(`${file}: suite ${s} is not part of trixie`);
  }
  if (!signedBy) issues.push(`${file}: missing Signed-By`);
}

/** WSOS-APT-003: never remove these, directly or as a side effect. Kernel images match by prefix. */
export const CRITICAL = new Set([
  'worksuite-desktop', 'worksuite-shell', 'worksuite-session', 'worksuite-panel', 'worksuite-wayland-bridge', 'worksuite-background',
  'worksuite-user-services', 'worksuite-package-service', 'worksuite-device-agent', 'worksuite-archive-keyring',
  'labwc', 'greetd', 'gtkgreet', 'worksuite-greeter', 'gtklock', 'swayidle', 'systemd', 'dpkg', 'apt', 'cryptsetup', 'grub-efi-amd64', 'grub-efi-arm64', 'shim-signed',
]);
export const isCritical = (name: string) => CRITICAL.has(name.replace(/:\w+$/, '')) || /^linux-image-/.test(name);

/** Catalog ids are "<source>:<name>" with conservative names (no options, paths or URLs). */
export function parseCatalogId(source: string, catalogId: string): string {
  const prefix = `${source}:`;
  const name = catalogId.startsWith(prefix) ? catalogId.slice(prefix.length) : catalogId;
  const ok = source === 'flatpak' ? /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$/.test(name) : /^[a-z0-9][a-z0-9+.-]{1,99}$/.test(name);
  if (!ok) throw new ServiceError('InvalidArgs', 'catalog id');
  return name;
}

export class ServiceError extends Error {
  readonly code: 'NotAuthorized' | 'NotInCatalog' | 'ArchMismatch' | 'Busy' | 'PreconditionFailed' | 'SignatureInvalid' | 'Failed' | 'InvalidArgs' | 'Protected' | 'SourcesInvalid' | 'NoSuchJob';
  constructor(code: ServiceError['code'], message: string = code) { super(message); this.code = code; }
}
