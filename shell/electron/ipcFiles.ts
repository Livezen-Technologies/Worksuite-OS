import { clipboard, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { scopeCommand } from './session'
import { brokerCall, followSessionLock, publicAccounts, syncCall } from './broker'
import { followJobs } from './packages'
import { execProgram, findOffice, installedApps } from './xdg'
import { archiveJobs, listIn } from './archives'
import { startAIHost } from './ai'
import { rootFor, volumesBridge, watchVolumes } from './volumes'
import { driveDir, dropPlan, freeBytes, list, resolveIn, roots } from './files'
import { eject, jobs as fileJobs, desktopDir, mkdirIn, newFileIn, places, recent, removeIn, renameIn, search, setStar, starred, starredHits, templates, trash, trashDelete, trashList, trashRestore } from './fileops'
import { isOfficeDoc, launchAndWait, openWithLock } from './officeLock'
import { fileHead, isWindowsProgram } from './winexe'
import type { FileEnv } from './files'
import { shellContents, broadcast, handle } from './shellCore'

// Shell IPC: Files, archives, volumes, the on-device AI host and package job events (from main.ts).

// Drag image for files dragged out of Files (startDrag needs one): a small document glyph.
const DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR4nGNgoCaQz/7/nxiM1wBCYNSAUQNGigEUZSZyAAAnXe3wcJ4r8wAAAABJRU5ErkJggg=='

export function registerFilesIpc(files: FileEnv) {
  // On-device AI assistant (services/ai): Settings › AI, the assistant panel and its context actions.
  startAIHost(handle, broadcast, files, { readClipboard: () => clipboard.readText() })
  handle('ws:filesRoots', () => ({ roots: roots(files).map(({ id, label }) => ({ id, label })), drive_exists: existsSync(driveDir(files.home)) }))
  handle('ws:filesList', (root, rel) => list(files, root, rel))
  handle('ws:filesOpen', async (root, rel) => {
    const p = resolveIn(files, root, rel)
    if (!p || !existsSync(p.full)) return { ok: false, error: 'not_found' }
    // Windows programs are never opened or run; the renderer shows why (WSOS-LCH-003).
    if (isWindowsProgram(p.full, fileHead(p.full))) return { ok: false, error: 'windows_program' }
    // Drive documents open in WorkSuite Office under the server file lock (WSOS-DRV-003, electron/officeLock.ts).
    const office = root === 'drive' && isOfficeDoc(p.full) ? findOffice(installedApps()) : null
    const prog = office ? execProgram(office.exec) : null
    if (office && prog) {
      const r = await openWithLock(rel, p.full, { syncCall, launch: (f) => { const c = scopeCommand(office.id, [prog, f]); return c ? launchAndWait(c) : Promise.resolve() } })
      return { ok: true, value: r.outcome }
    }
    const err = await shell.openPath(p.full)          // default app via XDG (WSOS-DSK-009)
    return err ? { ok: false, error: err } : { ok: true, value: true }
  })
  handle('ws:filesStatus', async (root) => {
    const r = roots(files).find((x) => x.id === root)
    const drive = root === 'drive' ? await syncCall('DriveSummary') : null
    return { free_bytes: r ? freeBytes(r.path) : null, drive: drive?.ok ? drive.value : null }
  })
  const strs = (json: string): string[] => { try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  const fjobs = fileJobs(files, (e) => broadcast('ws:filesJob', e))
  handle('ws:filesPlaces', () => places(files))
  handle('ws:filesStarred', () => ({ keys: starred(files), hits: starredHits(files) }))
  handle('ws:filesStar', (root, rel, on) => setStar(files, root, rel, on === '1'))
  handle('ws:filesRecent', () => recent(files))
  handle('ws:filesSearch', (root, rel, q, kind, days) => search(files, root, rel, q, kind, Number(days) || 0))
  handle('ws:filesMkdir', (root, rel, name) => mkdirIn(files, root, rel, name))
  // Desktop right-click menu (#27): the XDG Desktop folder, "New" from ~/Templates, new empty files.
  handle('ws:desktopDir', () => desktopDir(files))
  handle('ws:filesTemplates', () => templates(files))
  handle('ws:filesNewFile', (root, rel, name, template) => newFileIn(files, root, rel, name, template ? template : null))
  handle('ws:filesRename', (root, rel, name) => renameIn(files, root, rel, name))
  handle('ws:filesTrash', (root, rels) => trash(files, root, strs(rels)))
  handle('ws:filesDelete', (root, rels) => removeIn(files, root, strs(rels)))
  handle('ws:filesTrashList', () => trashList(files))
  handle('ws:filesTrashRestore', (ids) => trashRestore(files, strs(ids)))
  handle('ws:filesTrashDelete', (ids) => trashDelete(files, ids === 'all' ? 'all' : strs(ids)))
  // Drag and drop with other apps (WSOS-DSK-013): dropped paths inside the user's places are copied here by the
  // same jobs as paste; dragging files out hands real file paths to the compositor (text/uri-list for the target).
  handle('ws:filesDrop', (paths, dstRoot, dstRel) => {
    const plan = dropPlan(files, strs(paths))
    const jobs = plan.groups.map((g) => fjobs.start('copy', g.root, g.rels, dstRoot, dstRel)).filter((r) => r.ok).length
    return { ok: true, value: { jobs, rejected: plan.rejected } }
  })
  handle('ws:filesStartDrag', (root, rels) => {
    const paths = strs(rels).slice(0, 500).map((r) => resolveIn(files, root, r)?.full).filter((p): p is string => !!p && existsSync(p))
    const wc = [...shellContents].find((c) => !c.isDestroyed() && c.isFocused())
    if (!paths.length || !wc) return { ok: false, error: 'not_found' }
    wc.startDrag({ file: paths[0], files: paths, icon: nativeImage.createFromDataURL(DRAG_ICON) })
    return { ok: true, value: paths.length }
  })
  handle('ws:filesPaste', (op, srcRoot, rels, dstRoot, dstRel) => fjobs.start(op, srcRoot, strs(rels), dstRoot, dstRel))
  // Archives (electron/archives.ts): passwords arrive here only to go to 7z's stdin; they are never logged or sent back.
  const ajobs = archiveJobs(files, (e) => broadcast('ws:filesJob', e))
  handle('ws:filesResolve', (id, r, all) => (id.startsWith('arc') ? ajobs.resolve(id, r, all === '1') : fjobs.resolve(id, r, all === '1')))
  handle('ws:filesCompress', (root, rels, opts) => { try { return ajobs.compress(root, strs(rels), JSON.parse(opts)) } catch { return { ok: false, error: 'invalid' } } })
  handle('ws:filesExtract', (root, rel, mode, items, password) => ajobs.extract(root, rel, mode, strs(items), password || null))
  handle('ws:filesArchivePassword', (id, pw, cancel) => ajobs.password(id, cancel === '1' ? null : pw))
  handle('ws:filesArchiveList', (root, rel, password) => listIn(files, root, rel, password || null))
  handle('ws:filesEject', (id) => eject(files, id))
  // This Computer (#63): disks and volumes over udisks2; each entry says which Files root opens it.
  const vols = volumesBridge()
  handle('ws:filesVolumes', async () => {
    const r = await vols.list()
    if (!r.ok) return r
    const rs = roots(files)
    return { ok: true, value: r.value.map((v) => ({ ...v, root: rootFor(v, rs) })) }
  })
  handle('ws:filesVolMount', async (device) => {
    const r = await vols.mount(device)
    return r.ok ? { ok: true, value: rootFor({ mountpoint: r.value, kind: 'removable' }, roots(files)) ?? '' } : r
  })
  handle('ws:filesVolUnmount', (device) => vols.unmount(device))
  handle('ws:filesVolEject', (device) => vols.eject(device))
  watchVolumes(() => broadcast('ws:filesVolumesChanged', null))
  followJobs((e) => broadcast(e.kind === 'update_status' ? 'ws:updateStatusChanged' : e.kind === 'drivers' ? 'ws:driversChanged' : 'ws:pkgJob', e.kind === 'update_status' || e.kind === 'drivers' ? e.status : e))
  handle('ws:cloudAccounts', async () => {
    const r = await brokerCall('Status')
    return r.ok ? { ok: true, value: publicAccounts(r.value) } : r
  })
  followSessionLock((locked) => void brokerCall(locked ? 'Lock' : 'Unlock'))
}
