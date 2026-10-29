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
/** #69: Debian's own mirrors (ftp.<cc>.debian.org, cdn-*.deb.debian.org, …). tidyLegacySources pins their unsigned
 *  sources.list lines to Debian's archive keyring; checkEntry approves them only through that keyring, because
 *  *.debian.org also serves archives Debian does not sign (people.debian.org, personal repositories). */
const DEBIAN_HOST = /(^|\.)debian\.org$/;
/** #69: a source pinned to Debian's archive keyring only ever installs what Debian signed, from whichever mirror it
 *  names (a local or national mirror, snapshot.debian.org). trixie ships the keyring as .pgp; older images used .gpg. */
const DEBIAN_KEYRING = /^\/(usr\/share\/keyrings|etc\/apt\/(trusted\.gpg\.d|keyrings))\/debian-archive-[A-Za-z0-9._-]*\.(gpg|pgp|asc)$/;

/** One deb822 stanza's fields (lower-case names). Continuation lines (leading space or tab) belong to the field above
 *  (an embedded Signed-By key block); comment lines are skipped (#69: a multi-line Signed-By read as missing). */
export function deb822Stanzas(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const stanza of text.split(/\n[ \t]*\n/)) {
    const f: Record<string, string> = {};
    let last: string | null = null;
    for (const line of stanza.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      if (/^[ \t]/.test(line) && last) { f[last] = `${f[last]}\n${line.trim()}`.trim(); continue; }
      const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
      if (m) { last = m[1].toLowerCase(); f[last] = m[2].trim(); } else last = null;
    }
    if (Object.keys(f).length) out.push(f);
  }
  return out;
}

const off = (v: string | undefined) => /^(no|false|0)$/i.test((v ?? 'yes').trim());

/** extraHosts: the configured Update Center / organisation mirror (https only) from /etc/worksuite/updates.json or policy.
 *  keyExists (optional): whether a Signed-By keyring file is on this computer; a missing one fails every download. */
export function checkSources(text: string, file: string, extraHosts: string[] = [], keyExists?: (path: string) => boolean): string[] {
  const issues: string[] = [];
  // deb822 (.sources) stanzas
  if (file.endsWith('.sources')) {
    for (const f of deb822Stanzas(text)) {
      if (!f.uris) continue;
      if (off(f.enabled)) continue;
      checkEntry({ uris: f.uris.split(/\s+/), suites: (f.suites ?? '').split(/\s+/).filter(Boolean), signedBy: f['signed-by'] ?? '', trusted: /^yes$/i.test(f.trusted ?? '') }, file, issues, extraHosts, keyExists);
    }
    return issues;
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!/^deb(-src)?\s/.test(line)) continue;
    // Options are the bracket right after the type; a cdrom: URI has brackets of its own.
    const om = /^deb(?:-src)?\s+\[([^\]]*)\]\s*/.exec(line);
    const opts = om?.[1] ?? '';
    const rest = (om ? line.slice(om[0].length) : line.replace(/^deb(-src)?\s+/, '')).trim();
    const cd = /^(cdrom:\[[^\]]*\]\S*)\s+(.*)$/.exec(rest);
    const [uri, suite] = cd ? [cd[1], cd[2].split(/\s+/)[0]] : rest.split(/\s+/);
    const opt = (k: string) => new RegExp(`(?:^|[\\s,])${k}=([^\\s]+)`).exec(opts)?.[1] ?? '';
    checkEntry({ uris: [uri], suites: suite ? [suite] : [], signedBy: opt('signed-by').replace(/,/g, ' '), trusted: /^yes$/i.test(opt('trusted')) }, file, issues, extraHosts, keyExists);
  }
  return issues;
}

function checkEntry(e: { uris: string[]; suites: string[]; signedBy: string; trusted: boolean }, file: string, issues: string[], extraHosts: string[] = [], keyExists?: (path: string) => boolean) {
  const embedded = /-----BEGIN PGP PUBLIC KEY BLOCK-----/.test(e.signedBy);
  const paths = embedded ? [] : e.signedBy.split(/\s+/).filter(Boolean);
  const debianSigned = paths.some((p) => DEBIAN_KEYRING.test(p));
  for (const uri of e.uris) {
    // An installation disc: APT still checks its signed Release file, and it is never reached over the network.
    if (/^cdrom:/.test(uri)) continue;
    let u: URL;
    try { u = new URL(uri); } catch { issues.push(`${file}: bad URI ${uri}`); continue; }
    const host = u.hostname;
    // Another host is approved only when Debian's archive keyring is its Signed-By (APT then accepts only what Debian
    // signed, from whichever mirror), or it is the configured Update Center over https.
    const ok = ALLOWED_HOSTS.includes(host) || (debianSigned && /^https?:$/.test(u.protocol)) || (u.protocol === 'https:' && extraHosts.includes(u.host));
    if (!ok) issues.push(`${file}: repository ${u.host} is not an approved source`);
  }
  for (const s of e.suites) {
    if (BAD_SUITES.test(s)) issues.push(`${file}: suite ${s} is not allowed (testing/unstable)`);
    else if (!OK_SUITES.test(s)) issues.push(`${file}: suite ${s} is not part of trixie`);
  }
  if (e.trusted) issues.push(`${file}: trusted=yes turns off signature checks`);
  if (e.uris.every((u) => /^cdrom:/.test(u))) return;
  if (!embedded && !paths.length) issues.push(`${file}: missing Signed-By`);
  else if (keyExists && paths.length && !paths.some(keyExists)) issues.push(`${file}: Signed-By key ${paths[0]} is not installed`);
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

/** live-build's binary stage writes /etc/apt/sources.list with the image's mirrors and no Signed-By; the image already
 *  has the same archives, signed, in sources.list.d/debian.sources. Those unsigned lines made every install fail the
 *  sources check (#45), and apt warned "configured multiple times". Lines a signed, enabled deb822 stanza already
 *  covers (same URI, suite, and its components) are commented out; anything else is left for checkSources to judge.
 *  live-build writes a deb-src line after every deb line (functions/sourcelist.sh); those were left in and still failed
 *  every driver install with "missing Signed-By" (#59). Source indices are never used here, so a deb-src line for an
 *  archive and suite a signed stanza covers is commented out too. #69: other Debian-archive lines get Debian's keyring as
 *  their Signed-By (debianKeyring, when it is installed). Returns the new text, or null when nothing changes. */
export function tidyLegacySources(list: string, deb822: string[], debianKeyring?: string): string | null {
  // #69: http:// and https:// name the same archive (the image's stanzas are https, an installer may write http).
  const norm = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const stanzas = deb822.flatMap(deb822Stanzas)
    .filter((f) => f.uris && f['signed-by'] && !off(f.enabled) && (f.types ?? 'deb').split(/\s+/).includes('deb'));
  let changed = false;
  const out = list.split('\n').map((raw) => {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^(deb|deb-src)\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) return raw;
    const [, type, uri, suite, comps] = m;
    const covered = stanzas.some((f) => f.uris.split(/\s+/).map(norm).includes(norm(uri)) && (f.suites ?? '').split(/\s+/).includes(suite)
      && (type === 'deb-src' || comps.split(/\s+/).filter(Boolean).every((c) => (f.components ?? '').split(/\s+/).includes(c))));
    if (!covered) {
      // #69: a Debian archive line no signed file covers (another mirror, an installer's sources.list) is pinned to
      // Debian's archive keyring, which APT already trusted it with, instead of blocking every install.
      let host = '';
      try { host = new URL(uri).hostname; } catch { /* not a URL */ }
      if (!debianKeyring || !DEBIAN_HOST.test(host) || /\[/.test(line.split(/\s+/)[1] ?? '')) return raw;
      changed = true;
      return raw.replace(/^(\s*deb(?:-src)?)\s+/, `$1 [signed-by=${debianKeyring}] `);
    }
    changed = true;
    return `# ${raw.trim()}   # in sources.list.d (signed); disabled by worksuite-package-service`;
  });
  return changed ? out.join('\n') : null;
}
