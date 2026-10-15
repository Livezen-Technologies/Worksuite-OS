// Browser preview only (never in Electron, where window.worksuite exists): `?appc=sample` gives the App Center an
// enrolled-device catalog so the G08–G10 board states can be reviewed without a package service, the same way
// `?upd=` and `?hw=` drive the update and device boards. Without the parameter the preview keeps saying there is
// no catalog.
import type { AppCatalog, AppImageRecord, AppPermissions, CloudResult, LocalDebPreview, WorkSuiteApi } from './os'

const ITEMS: AppCatalog = { state: 'ok', arch: 'amd64', fetched_at: Date.now(), items: [
  { id: 'flatpak:org.kde.krita', source: 'flatpak', name: 'Krita', arches: ['amd64'], category: 'Graphics', summary: 'Digital painting for designers', publisher: 'KDE', installed: false, available: true, blocked_reason: null },
  { id: 'flatpak:com.spotify.Client', source: 'flatpak', name: 'Spotify', arches: ['amd64'], category: 'Music', summary: 'Music streaming', publisher: 'Spotify AB', installed: false, available: true, blocked_reason: null },
  { id: 'apt:code', source: 'apt', name: 'VS Code', arches: ['amd64'], category: 'Developer', summary: 'Code editor', publisher: 'Microsoft', installed: true, available: true, blocked_reason: null },
  { id: 'flatpak:com.slack.Slack', source: 'flatpak', name: 'Slack', arches: ['amd64'], category: 'Chat', summary: 'Team messaging', publisher: 'Slack Technologies', installed: true, available: true, blocked_reason: null },
  { id: 'flatpak:org.gimp.GIMP', source: 'flatpak', name: 'GIMP', arches: ['amd64'], category: 'Graphics', summary: 'Image editor', publisher: 'The GIMP team', installed: true, available: true, blocked_reason: null },
  { id: 'apt:zoom', source: 'apt', name: 'Zoom', arches: ['amd64'], category: 'Meetings', summary: 'Video meetings', publisher: 'Zoom Video Communications', installed: false, available: true, blocked_reason: null },
] }
const PERMS: AppPermissions = { app: 'com.slack.Slack', permissions: ['shared=network;ipc', 'sockets=pulseaudio;wayland', 'devices=all', 'filesystems=xdg-download'], overrides: [], broad: ['devices=all'] }
const DEB: LocalDebPreview = { package: 'zoom', version: '6.2.3.2056', architecture: 'amd64', publisher: 'Zoom Video Communications', publisher_verified: false, description: 'Zoom',
  plan: { install: [{ name: 'zoom', version: '6.2.3' }, { name: 'libxcb-xtest0', version: '' }, { name: 'libgl1', version: '' }, { name: 'libegl1', version: '' }, { name: 'ibus', version: '' }], upgrade: [], remove: [] },
  disk_bytes: 204e6, token: '9f2c41d0a8e3b7c65d4e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c' }
const AI: AppImageRecord = { id: '0123456789abcdef', name: 'Obsidian', version: '1.6.7', origin: 'file:///home/preview/Downloads', sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', arch: 'x86_64', size: 112e6,
  signature: { status: 'unsigned' }, approved: false, imported_at: new Date().toISOString(), approved_at: null, categories: ['Office'] }

export function withAppCenterPreview(api: WorkSuiteApi): WorkSuiteApi {
  if (typeof location === 'undefined' || new URLSearchParams(location.search).get('appc') !== 'sample') return api
  let off: string[] = ['filesystems=xdg-download']
  let imported: AppImageRecord[] = []
  const ok = <T,>(value: T): CloudResult<T> => ({ ok: true, value })
  return {
    ...api,
    async pkgCatalog() { return ok(ITEMS) },
    async installedApps() { const r = await api.installedApps(); return { ...r, apps: [...r.apps, { id: 'code', name: 'Visual Studio Code', generic_name: null, comment: null, icon: null, categories: [], keywords: [] }] } },
    async appPermissions() { return ok(PERMS) },
    async appPermsUserOff() { return ok(off) },
    async appPermSet(_id, perm, on) { off = on ? off.filter((p) => p !== perm) : [...off, perm]; return ok(true as const) },
    async pickFile(kind) { return ok({ handle: `${kind}:1`, name: kind === 'deb' ? 'zoom_amd64.deb' : 'Obsidian-1.6.7.AppImage' }) },
    async localDebPreview() { return ok(DEB) },
    async appimageList() { return ok(imported) },
    async appimageImport() { imported = [AI]; return ok(AI) },
    async appimageApprove() { imported = imported.map((r) => ({ ...r, approved: true })); return ok(imported[0]) },
    async appimageRemove() { imported = []; return ok({ removed: AI.id }) },
  }
}
