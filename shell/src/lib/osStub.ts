// Browser preview only (never in Electron): the stub API that answers in a plain browser (from os.ts).
import type { RadioDiagnosis } from '../../electron/radios'
import type { SignInMethods } from '../../electron/signin'
import { emptySnapshot, ymd } from '../../electron/widgets'
import type { CheckId, CheckResult } from './recovery'
import { type WorkSuiteApi } from './osApi'
import { type Printer, type DriverReport, type OsUpdateStatus, type FileJob, type ArchiveEntry, type FileEntry } from './osTypes'
import { type ActivityStatus, type CloudAccount, type CloudResult } from './osDevice'
import { stubAvail, stubSys, stubSim, stubWait, PV, stubStart, dev, STUB_DEVICES, STUB_NEW, stubDriverListeners, stubReport, stubListeners, stubUpdateState, stubJobs, stubEmit, stubVolumes, stubFileJobs, STUB_DOCS, stubOsListeners } from './osStubData'

// Preview only (no helper in a plain browser): a PIN set up and one security key, so every state can be reviewed.
const previewSignin: SignInMethods = {
  pin: true, keys: [{ id: 'a1b2c3d4e5f60718', name: 'YubiKey 5 NFC', added: Date.UTC(2026, 8, 2) }], default: 'pin',
  allow_pin: true, pin_min_length: 6, pin_max_length: 6, attempt_limit: 3, key_present: true,
}

export const stub: WorkSuiteApi = {
  async authenticate(_user, password, method) {
    // Preview: the password "wrong" and the PIN 000000 are rejected so the error states can be reviewed.
    if (method === 'key') return { ok: true }
    if (method === 'pin') return password === '000000' || !/^[0-9]{4,12}$/.test(password) ? { ok: false, message: 'Incorrect PIN.' } : { ok: true }
    if (password === 'wrong') return { ok: false, message: 'Incorrect password. Try again.' }
    return password.length > 0 ? { ok: true } : { ok: false, message: 'Enter your password.' }
  },
  async lock() { return false },
  async logout() {},
  async power() {},
  async launchApp() {},
  // Preview: the shipped default (5 min), no policy maximum.
  async lockSettings() { return { timeout_s: stubLock, max_s: null, choices: [60, 120, 300, 600, 900, 1800, 3600, 0] } },
  async setLockTimeout(s) { stubLock = s; return { ok: true, value: { timeout_s: s, max_s: null, choices: [60, 120, 300, 600, 900, 1800, 3600, 0] } } },
  async openLink() {},
  // Preview: signed out, so search says so instead of inventing results.
  async search(q) {
    const query = q.trim()
    return { query, sources: query ? [{ source: 'worksuite', state: 'not_signed_in', hits: [] }, { source: 'drive', state: 'not_signed_in', hits: [] }] : [], hits: [] }
  },
  async recentFiles() { return { local: [], cloud: { state: 'not_signed_in', hits: [] } } },
  // Preview: signed out, so the widgets offer sign-in instead of inventing data.
  async widgets() { return emptySnapshot('not_signed_in', ymd(new Date())) },
  async openSearchResult() { return { ok: true } },
  async webApps() { return { ok: false, error: 'not_signed_in' } },
  async shellPrefs() { return { ok: false, error: 'not_signed_in' } },
  async setShellPrefs() { return { ok: false, error: 'not_signed_in' } },
  async installedApps() {
    return { apps: [
      { id: 'firefox-esr', name: 'Firefox ESR', generic_name: 'Web Browser', comment: null, icon: 'firefox-esr', categories: ['Network', 'WebBrowser'], keywords: ['internet', 'web'] },
      { id: 'foot', name: 'Foot', generic_name: 'Terminal', comment: null, icon: 'foot', categories: ['System', 'TerminalEmulator'], keywords: ['shell'] },
    ], office: null, desktop: null }
  },
  async launchOffice() {},
  async launchWorkSuite() {},
  async cloudSignIn(serverUrl, _mode) {
    stubAccounts = [{ id: 'preview:u-1', name: 'Preview User', server_url: serverUrl, state: 'signed_in' }]
    return { ok: true, value: stubAccounts[0] }
  },
  async cloudSignInCancel() { return { ok: true, value: false } },
  async cloudCheckServer(serverUrl) { return { ok: true, value: { server_url: new URL(serverUrl).origin, issuer: new URL(serverUrl).host } } },
  async cloudSignOut(id, choice) {
    stubAccounts = stubAccounts.filter((a) => a.id !== id)
    stubUnsent = 0
    return { ok: true, value: { exported: choice === 'export' ? '~/Documents/WorkSuite unsent changes.json' : null } }
  },
  async syncUnsent() { return { ok: true, value: stubUnsent } },
  async syncNow() { stubUnsent = Math.max(0, stubUnsent - 1); return { ok: true, value: true } },
  // Preview: offline with 14 pending, then back online on the second poll.
  async syncStatus() {
    stubPolls++
    return { ok: true, value: stubPolls < 2 ? { state: 'offline', pending: 14, failed: 0, conflicts: 0, last_sync: null } : { state: 'idle', pending: 0, failed: 0, conflicts: 0, last_sync: Date.now() } }
  },
  async securityStatus() {
    if (PV.get('security') === 'none') return null
    const risk = PV.get('security') === 'threat'
    return {
      overall: risk ? 'at_risk' : PV.get('security') === 'nodefs' ? 'attention' : 'protected', issues: risk ? ['threats_need_action'] : PV.get('security') === 'nodefs' ? ['no_signatures'] : [], managed: stubManaged, scanning: PV.get('security') === 'scanning',
      firewall: { active: true, policy_rules: stubManaged ? 3 : 0, log_blocked: stubManaged }, isolation: null,
      antivirus: { enabled: true, installed: true, engine: '1.0.7', signatures: 27431, signatures_at: Date.now() - 86_400_000, signatures_age_days: 1, updates: 'active', schedule: 'weekly', exclusions: 0,
        last_scan: { kind: 'quick', trigger: 'schedule', started: Date.now() - 7_300_000, finished: Date.now() - 7_200_000, files: 18_402, detections: risk ? 1 : 0 }, last_full_scan: Date.now() - 5 * 86_400_000,
        // #64 previews: ?security=nodefs (no virus definitions yet) and ?security=scanning (progress).
        ...(PV.get('security') === 'nodefs' ? { signatures: null, signatures_at: null, signatures_age_days: null, ready: false } : { ready: true }),
        progress: PV.get('security') === 'scanning' ? { kind: 'full', started: Date.now() - 95_000, files: 5_210, detections: 0, errors: 0, current: '/home/nimal/Documents/report.odt', elapsed_ms: 95_000 } : null,
        scans: [{ id: 's1', kind: 'quick', trigger: 'schedule', started: Date.now() - 7_300_000, finished: Date.now() - 7_200_000, files: 18_402, detections: risk ? 1 : 0 }] },
      threats: { active: risk ? 1 : 0, quarantined: 1 },
      history: [...(risk ? [{ id: 't2', at: Date.now() - 7_200_000, path: '/home/nimal/Downloads/invoice.pdf.exe', signature: 'Win.Trojan.Agent-1', action: 'detected' }] : []),
        { id: 't1', at: Date.now() - 9 * 86_400_000, path: '/home/nimal/Downloads/eicar.com', signature: 'Win.Test.EICAR_HDB-1', action: 'quarantined' }],
      firewall_alerts: [], retention_days: 90,
      realtime: { enabled: stubManaged, prevention: true, state: stubManaged ? 'active' : 'inactive', downloads: true },
      protected_folders: { folders: stubManaged ? ['~/Documents', '~/Pictures'] : [], mode: 'block', state: stubManaged ? 'active' : 'inactive' },
      app_control: { denied: stubManaged ? 2 : 0 }, web: { dns_blocked: stubManaged ? 12 : 0, dns_feeds: 0, dns_filter: stubManaged, dns_feed_entries: 0 },
      threat_intel: { feeds: stubManaged ? 1 : 0, entries: stubManaged ? 4210 : 0, updated: Date.now() - 3_600_000, errors: [] }, auto_patch: 'window',
      events: risk ? [{ id: 'e1', at: Date.now() - 600_000, kind: 'write_blocked', path: '/home/nimal/Documents/budget.ods', exe: '/home/nimal/.cache/x/run', signature: null, enforced: true, resolved: null }] : [],
      suspended: stubSuspended, quarantine: stubQuarantine,
    }
  },
  async securityScan() { return { ok: true, value: true } },
  async securityAction(method, ...args) {
    if (method === 'RestoreQuarantined' && PV.get('security') === 'threat') return { ok: false, error: 'still_detected' }
    stubQuarantine = stubQuarantine.filter((q) => q.id !== args[0]); stubSuspended = []
    return { ok: true, value: true }
  },
  onSecurityChanged() { return () => {} },
  async activityStatus() { return stubActivity() },
  async activityAck() { stubActivityAck = true; return stubActivity() },
  async activityRemote() { return { ok: true, value: { items: stubActivity().days.map((d) => ({ ...d, device_id: 'preview' })), device_events: [{ device_id: 'preview', at: Date.now() - 7 * 3_600_000, type: 'startup' as const }], live: [] } } },
  onActivityChanged() { return () => {} },
  async enrollDevice(_url, code) {
    if (code === 'BAD-CODE') return { ok: false, error: 'enrollment_rejected' }
    stubManaged = true
    return { ok: true, value: { device_id: 'preview-device', org_name: 'Livezen Technologies' } }
  },
  async pkgPreview(id, op) {
    if (id.includes('nmap')) return { ok: false, error: 'not approved by your organization' }
    return { ok: true, value: {
      plan: { install: op === 'install' ? [{ name: id.split(':')[1], version: '' }] : [], upgrade: [], remove: op === 'remove' ? [{ name: id.split(':')[1], version: '' }] : [] },
      disk_bytes: op === 'install' ? 418_000_000 : -418_000_000,
      permissions: id.startsWith('flatpak:') ? ['shared=network;ipc;', 'filesystems=xdg-pictures;', 'sockets=x11;wayland;'] : [],
      broad: id.startsWith('flatpak:') ? ['sockets=x11;wayland;'] : [],
    } }
  },
  async pkgInstall(id) { return stubJob(id, 'install') },
  async pkgRemove(id) { return stubJob(id, 'remove') },
  async pkgApplyUpdate() { const r = stubJob('update', 'update'); setTimeout(() => { stubUpdates = { packages: [], flatpaks: [] } }, 800); return r },
  async pkgCheckUpdates() { return { ok: true, value: { ...stubUpdates, reboot_required: false, state: 'idle' } } },
  onPkgJob(cb) { stubListeners.add(cb); return () => { stubListeners.delete(cb) } },
  async updateStatus(check) {
    if (check) { stubOs = { ...stubOs, last_check: Date.now() }; stubOsListeners.forEach((l) => l(stubOs)) }
    return { ok: true, value: stubOs }
  },
  async updateDefer() {
    if ((stubOs.deferrals_left ?? 0) <= 0) return { ok: true, value: false }
    stubOs = { ...stubOs, state: 'waiting', reason: 'deferred', deferrals_left: (stubOs.deferrals_left ?? 1) - 1 }
    stubOsListeners.forEach((l) => l(stubOs)); return { ok: true, value: true }
  },
  async updateInstallNow() {
    stubOs = { ...stubOs, state: 'installing', reason: null }; stubOsListeners.forEach((l) => l(stubOs))
    setTimeout(() => { stubOs = { ...stubOs, state: 'ready_to_restart', installed: stubOs.version ?? stubOs.installed }; stubOsListeners.forEach((l) => l(stubOs)) }, 1200)
    return { ok: true, value: true }
  },
  onUpdateStatus(cb) { stubOsListeners.add(cb); return () => { stubOsListeners.delete(cb) } },
  async filesRoots() { return { roots: [{ id: 'home', label: 'Home' }, { id: 'media:KINGSTON', label: 'KINGSTON' }, { id: 'drive', label: 'WorkSuite Drive' }], drive_exists: true } },
  async filesList(root, rel) {
    const t = Date.now()
    const f = (name: string, state: string, size: number | null, local = true, dir = false): FileEntry => ({ name, dir, size, modified: local ? t - 3_600_000 : null, state, local })
    if (root === 'drive' && !rel) return { ok: true, value: [f('Tenders 2026', 'folder', null, true, true), f('Finance', 'folder', null, true, true), f('Handbook.pdf', 'synced', 1_200_000)] }
    if (root === 'drive') return { ok: true, value: [
      f('SFCL proposal v3.docx', 'syncing', 6_400_000), f('TSHDA bid — pricing.xlsx', 'synced', 212_000),
      f('TSHDA bid — pricing (conflict preview-laptop 2026-10-15).xlsx', 'conflict', 208_000),
      f('MBSL digital media tender.pdf', 'online-only', null, false), f('Care Me platform — clarifications.pdf', 'pending', 480_000),
      f('Site walk-through recording.mp4', 'error', 6_200_000_000) ] }
    if (!rel) return { ok: true, value: [f('Documents', 'local', null, true, true), f('Downloads', 'local', null, true, true), f('notes.txt', 'local', 2_000)] }
    if (rel === 'Documents') return { ok: true, value: STUB_DOCS() }
    return { ok: true, value: [f('Invoice INV-2026-0418.pdf', 'local', 182_000), f('worksuite-agent-2.4.1.zip', 'local', 38_200_000)] }
  },
  async filesOpen() { return { ok: true, value: true } },
  async filesPlaces() { return { user: 'alex', folders: ['Documents', 'Downloads', 'Pictures', 'Music', 'Videos'], media: [{ id: 'media:KINGSTON', label: 'KINGSTON' }], disk: { device: 'luks-3f1c', label: '', encrypted: true, used: 12.8e9, total: 39.5e9 } } },
  async filesStarred() { return { keys: [], hits: [] } },
  async filesStar() { return { ok: true, value: [] } },
  async filesRecent() { return [] },
  async filesSearch(_r, _rel, q) {
    const hits = STUB_DOCS().filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase())).map((e) => ({ root: 'home', rel: `Documents/${e.name}`, name: e.name, dir: e.dir, size: e.size, modified: e.modified, where: '~/Documents' }))
    return { ok: true, value: { hits, ms: 12, truncated: false } }
  },
  async filesMkdir(_r, rel, name) { return { ok: true, value: rel ? `${rel}/${name}` : name } },
  async filesRename(_r, rel, name) { return { ok: true, value: name || rel } },
  async filesTrash(_r, rels) { return { ok: true, value: { count: rels.length, ids: rels.map((r) => r.split('/').pop()!) } } },
  async filesDelete(_r, rels) { return { ok: true, value: rels.length } },
  async filesNotify() { return true },
  async toastsAvailable() { return false },
  async toastShow() { return false },
  async filesTrashList() {
    const d = (days: number) => Date.now() - days * 86_400_000
    return [['Old logo.png', '~/Pictures', 0, 640_000], ['Draft v1.docx', '~/Documents/Projects', 1, 312_000], ['Invoice copy.pdf', '~/Downloads', 9, 220_000]]
      .map(([name, where, days, size]) => ({ id: String(name), name: String(name), dir: false, size: Number(size), orig: '', where: String(where), deleted: d(Number(days)) }))
  },
  async filesTrashRestore(ids) { return { ok: true, value: { restored: ids.length, skipped: 0 } } },
  async filesTrashDelete(ids) { return { ok: true, value: ids === 'all' ? 0 : ids.length } },
  async filesDrop(paths) { return { ok: true, value: { jobs: 0, rejected: paths.length } } },
  async filesStartDrag() { return { ok: false, error: 'unavailable' } },
  pathForFile() { return '' },
  async filesPaste(op, _s, rels, dstRoot) {
    // Preview: a job that stops on one conflict, then runs to the end; Pause holds it, like the real job service.
    const id = `stubjob${++stubJobSeq}`
    const total = rels.length, bytes = rels.length * 2_400_000
    const base: FileJob = { id, op: op === 'move' ? 'move' : 'copy', dest: dstRoot.startsWith('media:') ? dstRoot.slice(6) : '~/Documents', state: 'running', done: 0, total, bytes_done: 0, bytes_total: bytes, conflict: null,
      src: '~/Documents', current: rels[0].split('/').pop()!, free: 21_400_000_000, started: Date.now(), error: null, error_name: null }
    stubJobs.set(id, { job: base, paused: false, step: 0 })
    setTimeout(() => stubEmit({ ...base, state: 'conflict', conflict: { name: rels[0].split('/').pop()!, incoming: { size: 2_400_000, modified: Date.now() - 600_000 }, existing: { size: 2_100_000, modified: Date.now() - 12 * 86_400_000 }, remaining: rels.length - 1, index: 1, count: rels.length } }), 50)
    return { ok: true, value: id }
  },
  async filesResolve(id, r) {
    const s = stubJobs.get(id)
    if (!s) return { ok: false, error: 'not_found' }
    if (r === 'cancel') { stubJobs.delete(id); stubEmit({ ...s.job, state: 'cancelled' }); return { ok: true, value: true } }
    if (r === 'pause') { s.paused = true; stubEmit({ ...s.job, state: 'paused' }); return { ok: true, value: true } }
    s.paused = false
    const tick = () => {
      const cur = stubJobs.get(id)
      if (!cur || cur.paused) return
      cur.step++
      const f = Math.min(1, cur.step / 20)
      cur.job = { ...cur.job, state: f >= 1 ? 'done' : 'running', conflict: null, done: Math.round(cur.job.total * f), bytes_done: Math.round(cur.job.bytes_total * f), current: f >= 1 ? null : cur.job.current }
      stubEmit(cur.job)
      if (f < 1) setTimeout(tick, 300); else stubJobs.delete(id)
    }
    setTimeout(tick, 100)
    return { ok: true, value: true }
  },
  async filesCompress(_root, rels, o) {
    // Preview: a job that runs to the end.
    const base: FileJob = { id: 'stubarc', op: 'compress', dest: '~/Documents', name: `${o.name}.${o.format}`, state: 'running', done: 0, total: rels.length, bytes_done: 0, bytes_total: 48_000_000, conflict: null, ask: null, error: null }
    for (let i = 1; i <= 10; i++) setTimeout(() => stubFileJobs.forEach((l) => l({ ...base, state: i === 10 ? 'done' : 'running', bytes_done: i * 4_800_000, done: i === 10 ? rels.length : 0 })), i * 400)
    return { ok: true, value: base.id }
  },
  async filesExtract(_root, rel, mode, items, password) {
    const name = rel.split('/').pop()!
    const base: FileJob = { id: 'stubx', op: 'extract', dest: mode === 'folder' ? `~/Downloads/${name.replace(/\.[^.]+$/, '')}` : '~/Downloads', name, state: 'running', done: 0, total: items.length || 14, bytes_done: 0, bytes_total: 96_400_000, conflict: null, ask: null, error: null }
    setTimeout(() => stubFileJobs.forEach((l) => l(name.includes('agent') && !password ? { ...base, state: 'password', ask: { wrong: false } } : { ...base, bytes_done: 41_000_000 })), 50)
    return { ok: true, value: base.id }
  },
  async filesArchivePassword(id, pw) {
    stubFileJobs.forEach((l) => l({ id, op: 'extract', dest: '~/Downloads/worksuite-agent-2.4.1', name: 'worksuite-agent-2.4.1.zip', state: pw === null ? 'cancelled' : 'running', done: 3, total: 14, bytes_done: 41_000_000, bytes_total: 96_400_000, conflict: null, ask: null, error: null }))
    return { ok: true, value: true }
  },
  async filesArchiveList(_root, rel) {
    const e = (path: string, size: number | null, type: 'file' | 'dir' = 'file'): ArchiveEntry => ({ path, type, size, link: null, modified: Date.now() - 86_400_000 * 3, encrypted: false })
    const entries = [e('worksuite-agent', 0, 'dir'), e('worksuite-agent/bin', 0, 'dir'), e('worksuite-agent/bin/worksuite-agent', 61_200_000), e('worksuite-agent/bin/agentctl', 8_400_000),
      e('worksuite-agent/config', 0, 'dir'), e('worksuite-agent/config/agent.toml', 4_100), e('worksuite-agent/config/policies.json', 12_800), e('worksuite-agent/README.md', 9_600), e('worksuite-agent/LICENSE', 11_300), e('worksuite-agent/CHANGELOG.md', 38_000)]
    return rel.endsWith('.zip') ? { ok: true, value: { kind: 'zip', entries, encrypted: false, total: 69_676_800, packed: 38_200_000 } } : { ok: false, error: 'failed' }
  },
  onOpenArchive() { return () => {} },
  async filesEject() { return { ok: false, error: 'unavailable' } },
  async filesVolumes() { return { ok: true, value: stubVolumes.map((v) => ({ ...v })) } },
  async filesVolMount(device) { const v = stubVolumes.find((x) => x.device === device); if (!v) return { ok: false, error: 'gone' }; v.mountpoint = `/media/alex/${v.label}`; v.root = `media:${v.label}`; v.total = v.size; v.free = v.size / 2; return { ok: true, value: v.root } },
  async filesVolUnmount(device) { const v = stubVolumes.find((x) => x.device === device); if (!v) return { ok: false, error: 'gone' }; Object.assign(v, { mountpoint: null, root: null, total: null, free: null }); return { ok: true, value: true as const } },
  async filesVolEject() { return { ok: false, error: 'unavailable' } },
  onFilesVolumes() { return () => {} },
  onFilesJob(cb) { stubFileJobs.add(cb); return () => { stubFileJobs.delete(cb) } },
  async filesStatus(root) { return { free_bytes: 212e9, drive: root === 'drive' ? { states: { synced: 2, syncing: 1, pending: 1, conflict: 1, 'online-only': 1, error: 1 }, last_sync: Date.now() - 60_000, service_state: 'idle' } : null } },
  async deviceInfo() {
    return {
      agent: true, managed: stubManaged, org_name: stubManaged ? 'Livezen Technologies' : null, server: stubManaged ? 'work.livezentech.com' : null, last_check_in: stubManaged ? Date.now() - 4 * 60_000 : null,
      device: { hostname: 'LZT-LAP-0142', os_version: 'WorkSuite OS 1.0 (preview)', arch: 'amd64', kernel_version: '6.12', encrypted: true },
      policies: !stubManaged ? null : { version: 'preview', update_ring: 'pilot', update_mode: 'automatic', maintenance_window: '02:00-04:00', lock_timeout_max_s: 300, offline_access_days: 7, usb_storage: 'read_only', bluetooth: null, app_allowlist_size: 42 },
      kiosk: stubManaged && typeof location !== 'undefined' && new URLSearchParams(location.search).get('kiosk') === '1' ? { user: 'kiosk', app: { type: 'url', url: 'https://work.livezentech.com/reception' }, allowed_urls: ['https://work.livezentech.com/'], idle_reset_minutes: 2, show_on_screen_keyboard: true, exit_pin: true } : null,
    }
  },
  async cloudAccounts() { return { ok: true, value: stubAccounts } },
  async hwDevices() {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    const extra = PV.get('hw') === 'new' && Date.now() - stubStart > 3000 ? [STUB_NEW] : PV.get('hw') === 'problem' && Date.now() - stubStart > 3000 ? [{ ...STUB_NEW, driver: null, driver_version: null }] : []
    const more = PV.get('hw') === 'drivers' || PV.get('hw') === 'nvidia' ? [dev('pci:0000:00:1f.6', 'Ethernet Connection I219-V', 'Intel Corporation', 'network', 'pci', 'e1000e')] : []
    if (PV.get('hw') === 'nvidia') more.push(dev('pci:0000:01:00.0', 'AD102 [GeForce RTX 4090]', 'NVIDIA Corporation', 'graphics', 'pci', 'nouveau'))
    return { ok: true, value: [...STUB_DEVICES, ...more, ...extra] }
  },
  async hwDriverReport(check) {
    const hw = PV.get('hw')
    if (hw !== 'catalog' && hw !== 'drivers' && hw !== 'nvidia') return { ok: false, error: 'unavailable' }
    if (check) { stubDriverReport = { ...stubDriverReport, state: 'checking' }; stubDriverListeners.forEach((l) => l(stubDriverReport)); await stubWait(PV.get('slow') ? 60_000 : 1500) }
    stubDriverReport = { ...stubReport(hw), checked_at: Date.now() }
    return { ok: true, value: stubDriverReport }
  },
  onDriversChanged(cb) {
    stubDriverListeners.add(cb)
    // ?hw=drivers&notify=1: the "drivers available" notification a few seconds in.
    const t = PV.get('notify') ? setTimeout(() => cb(stubReport(PV.get('hw'))), 2500) : null
    return () => { stubDriverListeners.delete(cb); if (t) clearTimeout(t) }
  },
  async driversNotify() { return 0 },
  async hwMokPassword() { return PV.get('mok') ? { ok: true, value: '48213907' } : { ok: true, value: '' } },
  onOpenSettings() { return () => {} },
  async hwInstallDrivers(ids) {
    if (!['catalog', 'drivers', 'nvidia'].includes(PV.get('hw') ?? '')) return { ok: false, error: 'unavailable' }
    const job = `/lk/worksuite/PackageService1/job/${++stubJobId}`
    ids.forEach((id, i) => {
      setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 100, phase: id })), 400 + i * 100)
      if (i === 1) setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 62, phase: ids[1] })), 500)
    })
    return { ok: true, value: job }
  },
  async signinMethods() { return stubAvail({ ...previewSignin, keys: [...previewSignin.keys] }) },
  async signinPinSet(pin) { if (!/^[0-9]{4,12}$/.test(pin)) return { ok: false, error: 'digits_only' }; previewSignin.pin = true; return { ok: true } },
  async signinPinRemove() { previewSignin.pin = false; if (previewSignin.default === 'pin') previewSignin.default = 'password'; return { ok: true } },
  async signinKeyAdd(name) {
    await new Promise((r) => setTimeout(r, 1200))
    const id = Math.random().toString(16).slice(2, 10).padEnd(16, '0')
    previewSignin.keys.push({ id, name: name || 'Security key', added: Date.now() }); return { ok: true, id }
  },
  async signinKeyRemove(id) { previewSignin.keys = previewSignin.keys.filter((k) => k.id !== id); if (!previewSignin.keys.length && previewSignin.default === 'key') previewSignin.default = 'password'; return { ok: true } },
  async signinSetDefault(method) { previewSignin.default = method; return { ok: true } },
  async sysUsers() { return stubAvail({ current: 'preview', users: [{ login: 'preview', name: 'Preview User', uid: 1000, admin: true }, { login: 'second', name: 'Second User', uid: 1001, admin: false }] }) },
  async pkgRepair() { return stubJob('repair', 'repair') },
  async pkgState() { return { ok: false, error: 'service_unavailable' } },
  // Browser preview: no system to read, so no report (never sample logs).
  async reportCollect() { return { ok: false, error: 'service_unavailable' } },
  async reportSave() { return { ok: false, error: 'service_unavailable' } },
  async reportSend() { return { ok: false, error: 'service_unavailable' } },
  // Browser preview: there is no package service or server here, so these answer honestly instead of inventing apps.
  async pkgCatalog() { return { ok: true, value: { state: 'not_enrolled', arch: 'amd64', items: [], error: 'Preview mode: no package service, so there is no app catalog.' } } },
  async pkgRequestApp() { return { ok: false, error: 'service_unavailable' } },
  async updateHistory() { return { ok: false, error: 'service_unavailable' } },
  async appUpdates() { return { ok: false, error: 'service_unavailable' } },
  async updateApps() { return { ok: false, error: 'service_unavailable' } },
  async pickFile() { return { ok: false, error: 'service_unavailable' } },
  async localDebPreview() { return { ok: false, error: 'service_unavailable' } },
  async localDebInstall() { return { ok: false, error: 'service_unavailable' } },
  async appPermissions() { return { ok: false, error: 'service_unavailable' } },
  async appPermissionsReset() { return { ok: false, error: 'service_unavailable' } },
  async appDataRemove() { return { ok: false, error: 'service_unavailable' } },
  async pruneRuntimes() { return { ok: false, error: 'service_unavailable' } },
  // ?upd=offline previews G14 with a bundle on a USB drive; otherwise there is no package service here.
  async bundleInspect(h) { return h === 'wsupdate:preview' ? { ok: true, value: { release_id: 'os-1.1.2', version: '1.1.2', packages: 214, bytes: 377_487_360, critical: true, verified: true } } : { ok: false, error: 'service_unavailable' } },
  async bundleInstall() { return { ok: false, error: 'service_unavailable' } },
  async findBundles() { return { ok: true, value: PV.get('upd') === 'offline' ? [{ handle: 'wsupdate:preview', name: 'worksuite-1.1.2-offline.wsupdate', drive: 'KINGSTON' }] : [] } },
  async appimageList() { return { ok: true, value: [] } },
  async appimageImport() { return { ok: false, error: 'service_unavailable' } },
  async appimageApprove() { return { ok: false, error: 'service_unavailable' } },
  async appimageRemove() { return { ok: false, error: 'service_unavailable' } },
  async appimageUpdate() { return { ok: false, error: 'service_unavailable' } },
  async appimageLaunch() { return { ok: false, error: 'service_unavailable' } },
  async recoveryInfo() {
    const all = stubSim !== 'none'
    return { os_version: '1.1', disk: 'vda', firmware: 'EFI', failures: all ? 3 : null,
      luks: stubSim === 'none' ? [] : [{ device: '/dev/vda2', name: 'vda2', label: 'WorkSuite', version: '2', size_bytes: 42_412_802_048, unlocked: false }],
      features: { unlock: all, repair: true, snapshots: all, reinstall: all, copy_usb: false, terminal: false, report_usb: false } }
  },
  async recoveryCheck(id) {
    await stubWait(id === 'packages' ? 1500 : 700)
    const preview: Record<CheckId, CheckResult> = {
      boot: { status: 'ok', note: 'Fine' }, disk: { status: 'ok', note: 'Fine' }, crypt: { status: 'ok', note: 'Unlocked' },
      packages: stubSim === 'none' ? { status: 'unavailable', note: 'Package service isn’t running' } : { status: 'problem', note: 'Interrupted package changes', fixable: true },
      drivers: { status: 'unavailable', note: 'Not checked in this version' },
      update: stubSim === 'none' ? { status: 'unavailable', note: 'Update service isn’t running' } : { status: 'ok', note: 'Version 1.1' },
    }
    return preview[id]
  },
  async recoveryUnlock(_device, secret) {
    await stubWait(600)
    // Preview: a key starting 00000 (or the passphrase "wrong") is refused so the error state can be reviewed.
    return secret.startsWith('00000') || secret === 'wrong' ? { ok: false, error: 'wrong_key' } : { ok: true, value: true }
  },
  async recoverySnapshots() {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    const at = (d: number, h: number, m: number) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, m, 0, 0); return t.getTime() }
    return { ok: true, value: [
      { id: 'snap-4', title: 'Before update to 1.1', created: at(0, 2, 3), kind: 'automatic', os_version: '1.0', last_working: true },
      { id: 'snap-3', title: 'Weekly snapshot', created: at(4, 3, 0), kind: 'automatic', os_version: '1.0', last_working: false },
      { id: 'snap-2', title: 'Before installing Docs', created: at(7, 14, 22), kind: 'app install', os_version: '1.0', last_working: false },
      { id: 'snap-1', title: 'After first setup', created: at(14, 18, 40), kind: 'install', os_version: '1.0', last_working: false },
    ] }
  },
  async recoveryRestore() { await stubWait(800); return stubSim === 'none' ? { ok: false, error: 'unavailable' } : { ok: true, value: true } },
  async recoveryReinstall() { await stubWait(800); return stubSim === 'none' ? { ok: false, error: 'unavailable' } : { ok: true, value: true } },
  async recoveryCopyToUsb() { return { ok: false, error: 'unavailable' } },
  async recoveryTerminal() { return { ok: false, error: 'unavailable' } },
  async recoverySaveReport() { return { ok: false, error: 'unavailable' } },
  // Preview only: simulated host state; `?sim=none` shows every area as unavailable.
  async sysNetwork() { return stubAvail({ ...stubSys.net, networks: stubSys.net.wifi_enabled ? stubSys.net.networks : [] }) },
  async sysSetWifi(on) { stubSys.net.wifi_enabled = on; return stubAvail(true as const) },
  async sysWifiConnect(ssid, password) {
    await stubWait(700)
    if (password === 'wrong') return { ok: false, error: 'bad_password' }
    stubSys.net.networks = stubSys.net.networks.map((n) => ({ ...n, in_use: n.ssid === ssid }))
    return { ok: true }
  },
  async sysVpn() { return stubAvail({ connections: stubSys.vpn, user_vpn_allowed: true, vpn_required: false }) },
  async sysVpnImport() { return { ok: false, error: 'service_unavailable' } },
  async sysVpnImportOpenvpn() { return { ok: false, error: 'service_unavailable' } },
  async sysVpnConnect(uuid, on) { stubSys.vpn = stubSys.vpn.map((c) => c.uuid === uuid ? { ...c, active: on } : c); return stubAvail(true as const) },
  async sysVpnRemove(uuid) { stubSys.vpn = stubSys.vpn.filter((c) => c.uuid !== uuid || c.managed); return stubAvail(true as const) },
  async sysBluetooth() { return stubAvail(stubSys.bt) },
  async sysSetBluetooth(on) { stubSys.bt.powered = on; return stubAvail(true as const) },
  async sysBtConnect(address, on) { stubSys.bt.paired = stubSys.bt.paired.map((d) => d.address === address ? { ...d, connected: on } : d); return stubAvail(true as const) },
  async sysWifiRescan() { return stubAvail(true as const) },
  async sysWifiDisconnect() { stubSys.net.networks = stubSys.net.networks.map((n) => ({ ...n, in_use: false })); return stubAvail(true as const) },
  async radioDiagnose(kind) {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    const d: RadioDiagnosis = kind === 'wifi'
      ? { kind, status: 'ok', service: 'active', problems: [], hardware: [{ name: 'Wi-Fi 6E AX211 160MHz', driver: 'iwlwifi', ids: '8086:51f0' }], adapters: [{ name: 'wlan0', device: 'Wi-Fi 6E AX211 160MHz', driver: 'iwlwifi', soft_blocked: false, hard_blocked: false }] }
      : { kind, status: stubSys.bt.powered ? 'ok' : 'off', service: 'active', problems: [], hardware: [], adapters: [{ name: 'hci0', device: null, driver: 'btusb', soft_blocked: false, hard_blocked: false }] }
    return { ok: true, value: { ...d, text: `${kind}: ${d.status}` } }
  },
  async radioFix() { return { ok: true, value: true } },
  async graphics() {
    if (stubSim === 'none') return { ok: false, error: 'unavailable' }
    return { ok: true, value: {
      gpus: [{ name: 'Alder Lake-P GT2 [Iris Xe Graphics]', vendor: 'Intel Corporation', ids: '8086:46a6', driver: 'i915', driver_version: null, proprietary: false, virtual: false }],
      compositor: { renderer: 'gpu', reason: null, choice: 'auto', fell_back: false },
      apps: { accelerated: true, disabled_reason: null, features: { gpu_compositing: 'enabled', rasterization: 'enabled', video_decode: 'enabled', webgl: 'enabled', webgpu: 'disabled_off' }, gl_renderer: 'Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2)', gl_version: 'OpenGL ES 3.2 Mesa 25.0.7', driver_vendor: 'Mesa', driver_version: '25.0.7' },
      vaapi: { available: true, driver: 'Intel iHD driver for Intel(R) Gen Graphics - 25.2.3', decode: ['H264Main', 'HEVCMain', 'VP9Profile0', 'AV1Profile0'], encode: ['H264Main', 'HEVCMain'] },
      vulkan: { available: true, api_version: '1.4.305', devices: [{ name: 'Intel(R) Iris(R) Xe Graphics (ADL GT2)', type: 'integrated_gpu', driver: 'Intel open-source Mesa driver Mesa 25.0.7' }] },
    } }
  },
  async graphicsSetRenderer() { return { ok: true, value: true } },
  async graphicsReset() { return { ok: true, value: true } },
  async sysSound() { return stubAvail(stubSys.sound) },
  async sysSetVolume(p) { stubSys.sound.volume = Math.max(0, Math.min(100, Math.round(p))); return stubAvail(true as const) },
  async sysSetMute(m) { stubSys.sound.muted = m; return stubAvail(true as const) },
  async sysSetDefaultAudio(id) { stubSys.sound.outputs = stubSys.sound.outputs.map((o) => ({ ...o, is_default: o.id === id })); return stubAvail(true as const) },
  async sysBattery() { return stubAvail({ present: true, percentage: 74, state: 'charging', time_to_full_s: 4800, time_to_empty_s: null, on_battery: false }) },
  async sysPrinters() { return stubAvail([{ name: 'HP_LaserJet_M507_Floor3', state: 'idle', is_default: true }] as Printer[]) },
  async sysDisplays() { return stubAvail([{ name: 'eDP-1', description: 'Built-in display', enabled: true, width: 1920, height: 1200, refresh: 60, scale: 1 }]) },
  async sysDisks() { return stubAvail([{ model: 'Preview NVMe SSD', serial: 'PREVIEW0001', device: 'nvme0n1' }]) },
}

let stubLock = 300
let stubDriverReport: DriverReport = { state: 'idle', checked_at: null, online_search: true, metered: false, secure_boot: false, devices: [], offers: [], auto_installed: [] }
let stubAccounts: CloudAccount[] = []
let stubJobId = 0
// Preview: a mandatory security release waiting for the user.
let stubOs: OsUpdateStatus = stubUpdateState(PV.get('upd'))
// Preview: drive the update job the way the package service does (JobProgress phases, then a status change).
if (typeof window !== 'undefined') {
  const k = PV.get('upd')
  const job = '/lk/worksuite/PackageService1/job/90'
  const emitJob = (percent: number, phase: string) => stubListeners.forEach((l) => l({ job, kind: 'progress', percent, phase }))
  const setOs = (p: Partial<OsUpdateStatus>) => { stubOs = { ...stubOs, ...p }; stubOsListeners.forEach((l) => l(stubOs)) }
  if (k === 'downloading') setTimeout(() => emitJob(41, 'downloading'), 400)
  if (k === 'offline') setTimeout(() => emitJob(70, 'downloading'), 400)
  if (k === 'forced') { setTimeout(() => setOs({ state: 'installing', reason: null, restart_at: null }), 600); setTimeout(() => emitJob(50, 'applying'), 800) }
  if (k === 'failed') { setTimeout(() => emitJob(50, 'applying'), 400); setTimeout(() => setOs({ state: 'failed', reason: 'dpkg: error processing package linux-image-6.12 (--configure)' }), 700) }
}
let stubJobSeq = 0
let stubUpdates = { packages: ['firefox-esr', 'libc6', 'openssl'], flatpaks: ['org.gimp.GIMP'] }
function stubJob(_id: string, _kind: string): CloudResult<string> {
  const job = `/lk/worksuite/PackageService1/job/${++stubJobId}`
  setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'progress', percent: 50, phase: 'installing' })), 300)
  setTimeout(() => stubListeners.forEach((l) => l({ job, kind: 'finished', result: 'success' })), 900)
  return { ok: true, value: job }
}
// Preview only: pretend three offline edits are waiting so the sign-out prompt can be seen.
let stubUnsent = 3
let stubPolls = 0
// Preview only: unmanaged until enrolled (first-run or Settings).
let stubActivityAck = false
/** Preview: ?monitoring=1 shows employee monitoring on (with the first-run disclosure until it is acknowledged). */
function stubActivity(): ActivityStatus {
  const on = PV.get('monitoring') === '1'
  const day = new Date().toISOString().slice(0, 10)
  const web = on && PV.get('web') === '1'
  return { enabled: on, org_name: on ? 'Livezen Technologies' : null, retention_days: 90, idle_threshold_s: 300, disclosure_needed: on && !stubActivityAck, last_sent: on ? Date.now() - 600_000 : null,
    web_domains: web, live: on ? { state: 'active', app_id: 'org.worksuite.Office', at: Date.now() - 30_000 } : null,
    days: on ? [{ day, active_s: 13_320, idle_s: 1_800, locked_s: 2_700, first_active: Date.now() - 6 * 3_600_000, last_active: Date.now(), events: [{ at: Date.now() - 6 * 3_600_000, type: 'login' }],
      apps: [{ app_id: 'org.worksuite.Office', name: 'WorkSuite Office', active_s: 7_900, switches: 31 }, { app_id: 'org.mozilla.firefox', name: 'Firefox', active_s: 3_600, switches: 24 }, { app_id: 'foot', name: 'Terminal', active_s: 1_820, switches: 9 }],
      ...(web ? { domains: [{ domain: 'mail.worksuite.lk', active_s: 2_400 }, { domain: 'drive.worksuite.lk', active_s: 900 }] } : {}) }] : [] }
}
// Preview (#38): one quarantined file and, with ?security=threat, one suspended program.
let stubQuarantine = [{ id: '0f0e0d0c-0b0a-4908-8706-050403020100', at: Date.now() - 9 * 86_400_000, path: '/home/nimal/Downloads/eicar.com', signature: 'Win.Test.EICAR_HDB-1' }]
let stubSuspended = typeof location !== 'undefined' && new URLSearchParams(location.search).get('security') === 'threat'
  ? [{ id: '1f0e0d0c-0b0a-4908-8706-050403020100', at: Date.now() - 300_000, path: '/home/nimal/Documents/report.odt.locked', exe: '/usr/bin/python3', pid: 4242 }] : []
let stubManaged = typeof location !== 'undefined' && new URLSearchParams(location.search).get('managed') === '1'
