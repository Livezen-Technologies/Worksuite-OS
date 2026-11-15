// G14 "Update from a USB drive": offline .wsupdate bundles (WSOS-AUP-010) found at the top level of mounted
// removable drives, so the Updates page can offer one without a file dialog. Only file names and the drive label
// reach the renderer; main.ts keeps the paths behind opaque handles, the same as pickFile('wsupdate').
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DiskVolume } from './volumes'

export interface FoundBundle { path: string; name: string; drive: string; mtime: number }

/** Newest first; at most 4 per drive. Unreadable drives and non-files are skipped. */
export function findBundles(drives: { label: string; path: string }[]): FoundBundle[] {
  const out: FoundBundle[] = []
  for (const d of drives) {
    let names: string[]
    try { names = readdirSync(d.path) } catch { continue }
    const found: FoundBundle[] = []
    for (const n of names) {
      if (!n.endsWith('.wsupdate') || n.startsWith('.')) continue
      const p = path.join(d.path, n)
      try { const s = statSync(p); if (s.isFile()) found.push({ path: p, name: n, drive: d.label, mtime: s.mtimeMs }) } catch { /* skip */ }
    }
    out.push(...found.sort((a, b) => b.mtime - a.mtime).slice(0, 4))
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Filesystems a USB stick with a bundle on it would use. */
const STICK_FS = new Set(['vfat', 'exfat', 'ntfs', 'ntfs3', 'ext4', 'ext3', 'ext2', 'btrfs', 'xfs', 'f2fs', 'iso9660', 'udf'])

/**
 * Nothing mounts a USB drive by itself, so a stick plugged in for "Install from a USB drive" would never be seen.
 * While that card is looking (the person asked to install from USB), plugged-in removable drives are mounted the way
 * Files mounts them (udisks; polkit lets the person at the computer mount removable media without a prompt).
 * Never internal disks, never locked (encrypted) volumes, never anything already mounted. Returns the new mount points.
 */
export async function mountRemovable(vols: { list(): Promise<{ ok: true; value: DiskVolume[] } | { ok: false; error: string }>; mount(device: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> }): Promise<string[]> {
  const l = await vols.list()
  if (!l.ok) return []
  const out: string[] = []
  for (const v of l.value) {
    if (v.kind !== 'removable' || v.mountpoint || v.locked || !STICK_FS.has(v.fstype)) continue
    const r = await vols.mount(v.device)
    if (r.ok && r.value) out.push(r.value)
  }
  return out
}
