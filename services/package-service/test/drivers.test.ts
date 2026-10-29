// Driver search: modalias / Contents mapping, kernel-log parsing, the once-a-day trigger, policy, metered, GPUs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aliasMatches, autoInstallable, contentsLookup, DAY, deviceKind, deviceStatuses, displayDriverLabel, dkmsFor, driverPolicy, gpuOffer,
  needsGpuFallback, nvidiaPick, parseFirmwareFailures, parseInstalled, parseFwupd, parseIsenkram, shouldCheck, type DriverOffer, type ScannedDevice,
} from '../src/drivers.ts';
import { aptError, DriverManager, mokPassword, parseAptStatus, parseModulesAlias, scanSysfs, type DriverEnv } from '../src/driverscan.ts';
import { checkSources, tidyLegacySources } from '../src/apt.ts';

const INTEL_AX211 = 'pci:v00008086d000051F0sv00008086sd00000094bc02sc80i00';
const dev = (o: Partial<ScannedDevice>): ScannedDevice => ({ id: 'pci:0000:00:14.3', bus: 'pci', modaliases: [INTEL_AX211], driver: 'iwlwifi', module: 'iwlwifi', cls: '0x028000', vendor: '8086', product: '51f0', ...o });

const KLOG = `[    5.1] iwlwifi 0000:00:14.3: Direct firmware load for iwlwifi-so-a0-gf-a0-89.ucode failed with error -2
[    5.2] iwlwifi 0000:00:14.3: Direct firmware load for iwlwifi-so-a0-gf-a0-88.ucode failed with error -2
[    6.0] r8169 0000:02:00.0: Unable to load firmware rtl_nic/rtl8168h-2.fw (-2)
[    6.1] bluetooth hci0: Direct firmware load for ../../etc/shadow failed with error -2
[    7.0] firmware: failed to load rtl_nic/rtl8168h-2.fw (-2)
usb 1-2: new high-speed USB device number 3`;

test('firmware failures: file, driver and device from the kernel log; no paths outside /lib/firmware', () => {
  const f = parseFirmwareFailures(KLOG);
  assert.deepEqual(f.map((x) => x.file), ['iwlwifi-so-a0-gf-a0-89.ucode', 'iwlwifi-so-a0-gf-a0-88.ucode', 'rtl_nic/rtl8168h-2.fw']);
  assert.deepEqual(f[0], { file: 'iwlwifi-so-a0-gf-a0-89.ucode', driver: 'iwlwifi', device: '0000:00:14.3' });
  assert.equal(f[2].driver, 'r8169');
});

const CONTENTS = `usr/lib/firmware/iwlwifi-so-a0-gf-a0-89.ucode.zst                  non-free-firmware/kernel/firmware-iwlwifi
usr/lib/firmware/rtl_nic/rtl8168h-2.fw                              non-free-firmware/kernel/firmware-realtek
usr/lib/firmware/mt7921/WIFI_RAM_CODE_MT7961_1.bin                  non-free-firmware/kernel/firmware-mediatek`;

test('Contents lookup: firmware file → Debian package (compressed variants match)', () => {
  const m = contentsLookup(CONTENTS, ['iwlwifi-so-a0-gf-a0-89.ucode', 'rtl_nic/rtl8168h-2.fw', 'nope.bin']);
  assert.equal(m.get('iwlwifi-so-a0-gf-a0-89.ucode'), 'firmware-iwlwifi');
  assert.equal(m.get('rtl_nic/rtl8168h-2.fw'), 'firmware-realtek');
  assert.equal(m.has('nope.bin'), false);
});

test('modalias patterns: fnmatch like modules.alias', () => {
  assert.ok(aliasMatches('pci:v00008086d000051F0sv*sd*bc*sc*i*', INTEL_AX211));
  assert.ok(aliasMatches('pci:v00008086d*sv*sd*bc02sc80i*', INTEL_AX211));
  assert.ok(!aliasMatches('pci:v000014E4d*sv*sd*bc*sc*i*', INTEL_AX211));
  assert.ok(aliasMatches('usb:v0BDAp[89]*d*', 'usb:v0BDAp8812d0000dc00dsc00dp00ic00isc00ip00in00'));
  const a = parseModulesAlias('alias pci:v00008086d000051F0sv*sd*bc*sc*i* iwlwifi\nalias acpi*:X* foo\n');
  assert.deepEqual(a, [{ pattern: 'pci:v00008086d000051F0sv*sd*bc*sc*i*', module: 'iwlwifi' }]);
});

test('DKMS catalog: Broadcom BCM4360 without a kernel driver → broadcom-sta-dkms (amd64 only); never when the kernel has one', () => {
  const bcm = dev({ id: 'pci:0000:03:00.0', modaliases: ['pci:v000014E4d000043A0sv0000106Bsd00000117bc02sc80i00'], driver: null, module: null, vendor: '14e4', product: '43a0' });
  assert.equal(dkmsFor(bcm, 'amd64')?.package, 'broadcom-sta-dkms');
  assert.equal(dkmsFor(bcm, 'arm64'), null);
  assert.equal(dkmsFor({ ...bcm, module: 'bcma' }, 'amd64'), null);
  assert.equal(dkmsFor(dev({}), 'amd64'), null);
});

test('isenkram output: only driver and firmware packages', () => {
  assert.deepEqual(parseIsenkram('firmware-iwlwifi\nprinter-driver-foo\nbroadcom-sta-dkms\n; rm -rf /\nfirmware-iwlwifi\n'), ['firmware-iwlwifi', 'broadcom-sta-dkms']);
});

test('policy: defaults, admin choices, kiosk forces search on and firmware only', () => {
  assert.deepEqual(driverPolicy(null), { online_search: true, auto_firmware: true, auto_gpu: false });
  assert.deepEqual(driverPolicy({ drivers_online_search: false, drivers_auto_install: false, drivers_auto_install_gpu: true }), { online_search: false, auto_firmware: false, auto_gpu: true });
  assert.deepEqual(driverPolicy({ drivers_online_search: false, drivers_auto_install_gpu: true, kiosk: { enabled: true } }), { online_search: true, auto_firmware: true, auto_gpu: false });
});

const offer = (o: Partial<DriverOffer>): DriverOffer => ({ id: 'fw:firmware-iwlwifi', device_id: null, kind: 'firmware', packages: ['firmware-iwlwifi'], name: '', summary: '', from_version: null, to_version: '', license: 'proprietary', category: 'recommended', size_bytes: 1e6, restart: false, ...o });

test('auto-install: firmware by policy, DKMS never, GPU only with its policy and never under Secure Boot, nothing big on metered', () => {
  const pol = driverPolicy(null), free = { metered: false, secureBoot: false };
  assert.equal(autoInstallable(offer({}), pol, free), true);
  assert.equal(autoInstallable(offer({}), driverPolicy({ drivers_auto_install: false }), free), false);
  assert.equal(autoInstallable(offer({ kind: 'dkms' }), pol, free), false);
  assert.equal(autoInstallable(offer({ kind: 'gpu' }), pol, free), false);
  const gpuPol = driverPolicy({ drivers_auto_install_gpu: true });
  assert.equal(autoInstallable(offer({ kind: 'gpu' }), gpuPol, free), true);
  assert.equal(autoInstallable(offer({ kind: 'gpu' }), gpuPol, { metered: false, secureBoot: true }), false);
  assert.equal(autoInstallable(offer({ size_bytes: 1e6 }), pol, { metered: true, secureBoot: false }), true);
  assert.equal(autoInstallable(offer({ size_bytes: 100e6 }), pol, { metered: true, secureBoot: false }), false);
  assert.equal(autoInstallable(offer({ size_bytes: null }), pol, { metered: true, secureBoot: false }), false);
});

test('trigger: connectivity once a day or on new hardware; manual any time (≥ 1 min apart); off by policy', () => {
  const pol = driverPolicy(null), now = 10 * DAY;
  assert.equal(shouldCheck({}, 'connectivity', now, 'a', pol), true);
  assert.equal(shouldCheck({ last_check: now - 3_600_000, hw_fingerprint: 'a' }, 'connectivity', now, 'a', pol), false);
  assert.equal(shouldCheck({ last_check: now - DAY, hw_fingerprint: 'a' }, 'connectivity', now, 'a', pol), true);
  assert.equal(shouldCheck({ last_check: now - 3_600_000, hw_fingerprint: 'a' }, 'timer', now, 'b', pol), true);
  assert.equal(shouldCheck({ last_check: now + DAY, hw_fingerprint: 'a' }, 'timer', now, 'a', pol), true);   // clock went back
  assert.equal(shouldCheck({ last_manual: now - 5_000 }, 'manual', now, 'a', pol), false);
  assert.equal(shouldCheck({ last_manual: now - 61_000, last_check: now }, 'manual', now, 'a', pol), true);
  assert.equal(shouldCheck({}, 'manual', now, 'a', driverPolicy({ drivers_online_search: false })), false);
});

test('GPU mapping: Maxwell+ → nvidia-driver 550; compute cards → tesla 535; Kepler and older stay on nouveau', () => {
  assert.deepEqual(nvidiaPick('2684', '0x030000'), { package: 'nvidia-driver', series: '550' });  // RTX 4090
  assert.deepEqual(nvidiaPick('1380', '0x030000'), { package: 'nvidia-driver', series: '550' });  // GTX 750 Ti
  assert.deepEqual(nvidiaPick('20b0', '0x030200'), { package: 'nvidia-tesla-535-driver', series: '535' }); // A100
  assert.deepEqual(nvidiaPick('1180', '0x030000'), { package: null, reason: 'too_old' });  // GTX 680 (Kepler)
  const rtx = dev({ id: 'pci:0000:01:00.0', cls: '0x030000', vendor: '10de', product: '2684', driver: 'nouveau', module: 'nouveau' });
  const o = gpuOffer(rtx, { secureBoot: false, mokEnrolled: false, nvidiaInstalled: false }, 'amd64')!;
  assert.deepEqual(o.packages, ['nvidia-driver', 'nvidia-kernel-dkms', 'linux-headers-amd64']);
  assert.equal(o.category, 'recommended'); assert.equal(o.restart, true); assert.equal(o.summary, 'nvidia_better');
  assert.equal(gpuOffer(rtx, { secureBoot: true, mokEnrolled: false, nvidiaInstalled: false }, 'arm64')!.summary, 'nvidia_secure_boot');
  assert.deepEqual(gpuOffer(rtx, { secureBoot: false, mokEnrolled: false, nvidiaInstalled: false }, 'arm64')!.packages[2], 'linux-headers-arm64');
  assert.equal(gpuOffer(rtx, { secureBoot: false, mokEnrolled: false, nvidiaInstalled: true }, 'amd64'), null);
  assert.equal(gpuOffer({ ...rtx, vendor: '1002', driver: 'amdgpu' }, { secureBoot: false, mokEnrolled: false, nvidiaInstalled: false }, 'amd64'), null);
  assert.equal(deviceKind(rtx), 'display');
  assert.equal(displayDriverLabel('amdgpu', null), 'Mesa (amdgpu)');
  assert.equal(displayDriverLabel('nvidia', '550.163.01'), 'NVIDIA 550');
});

test('GPU fallback: only after an nvidia install whose first boot lost the greeter or the module', () => {
  const base = { nvidiaInstalled: true, pendingBoot: true, greeterOk: true, nvidiaLoaded: true };
  assert.equal(needsGpuFallback(base), false);
  assert.equal(needsGpuFallback({ ...base, greeterOk: false }), true);
  assert.equal(needsGpuFallback({ ...base, nvidiaLoaded: false }), true);
  assert.equal(needsGpuFallback({ ...base, pendingBoot: false, greeterOk: false }), false);
  assert.equal(needsGpuFallback({ ...base, nvidiaInstalled: false, greeterOk: false }), false);
});

test('fwupd: get-updates JSON → offers', () => {
  const j = JSON.stringify({ Devices: [{ Name: 'UEFI dbx', DeviceId: 'a'.repeat(40), Version: '77', Releases: [{ Version: '83', Size: 24000, Summary: 'dbx', Urgency: 'high' }] }, { Name: 'x', DeviceId: 'bad' }] });
  const o = parseFwupd(j);
  assert.equal(o.length, 1); assert.equal(o[0].id, `fwupd:${'a'.repeat(40)}`); assert.equal(o[0].category, 'security');
  assert.deepEqual(parseFwupd('not json'), []);
});

test('statuses per device', () => {
  const wifi = dev({}), gpu = dev({ id: 'pci:0000:01:00.0', cls: '0x030000', vendor: '10de', product: '2684', driver: 'nouveau', module: 'nouveau' });
  const r = deviceStatuses([wifi, gpu, dev({ id: 'usb:1-2', bus: 'usb', driver: null, module: null, cls: 'ff' })], parseFirmwareFailures(KLOG), [offer({ device_id: wifi.id }), offer({ id: 'gpu:nvidia-driver', kind: 'gpu', device_id: gpu.id })]);
  assert.deepEqual(r.map((x) => x.status), ['missing_firmware', 'optional_driver', 'no_driver']);
  assert.equal(r[0].kind, 'wifi');
});

test('sysfs scan: PCI and USB devices with modaliases, drivers and the module that would bind', () => {
  const root = mkdtempSync(join(tmpdir(), 'drv-'));
  const pci = join(root, 'sys/bus/pci/devices/0000:00:14.3');
  mkdirSync(pci, { recursive: true });
  writeFileSync(join(pci, 'modalias'), INTEL_AX211 + '\n'); writeFileSync(join(pci, 'class'), '0x028000\n');
  writeFileSync(join(pci, 'vendor'), '0x8086\n'); writeFileSync(join(pci, 'device'), '0x51f0\n');
  mkdirSync(join(root, 'drivers/iwlwifi'), { recursive: true }); symlinkSync(join(root, 'drivers/iwlwifi'), join(pci, 'driver'));
  const usb = join(root, 'sys/bus/usb/devices/1-2');
  mkdirSync(join(usb, '1-2:1.0'), { recursive: true });
  writeFileSync(join(usb, 'idVendor'), '0bda\n'); writeFileSync(join(usb, 'idProduct'), '8812\n');
  writeFileSync(join(usb, '1-2:1.0/modalias'), 'usb:v0BDAp8812d0000dc00dsc00dp00icFFiscFFipFFin00\n'); writeFileSync(join(usb, '1-2:1.0/bInterfaceClass'), 'ff\n');
  const devs = scanSysfs(root, [{ pattern: 'usb:v0BDAp8812d*dc*dsc*dp*icFFiscFFipFFin*', module: 'rtw88_8812au' }]);
  assert.deepEqual(devs.map((d) => [d.id, d.driver, d.module]), [['pci:0000:00:14.3', 'iwlwifi', null], ['usb:1-2', null, 'rtw88_8812au']]);
});

function managerEnv(over: Partial<DriverEnv> = {}) {
  let st: Record<string, unknown> = {};
  const calls: string[] = [], audits: string[] = [];
  let jobs = 0;
  const env: DriverEnv = {
    async run(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'mokutil' && args[0] === '--generate-hash=' + args[0].slice(16)) return { code: 0, stdout: '$6$hash', stderr: '' };
      return { code: cmd === 'isenkram-lookup' || cmd === 'fwupdmgr' ? 2 : 0, stdout: cmd === 'mokutil' ? 'not enrolled' : '', stderr: '' };
    },
    devices: () => [dev({}), dev({ id: 'pci:0000:01:00.0', cls: '0x030000', vendor: '10de', product: '2684', driver: 'nouveau', module: 'nouveau', modaliases: [] })],
    kernelLog: async () => KLOG, firmwarePresent: () => false, contents: async () => CONTENTS, installed: () => false,
    policy: () => null, metered: async () => false, secureBoot: () => false, arch: 'amd64', now: () => 5 * DAY,
    load: () => st as never, save: (s) => { st = s as never; }, audit: (e) => audits.push(e), writeFile() {}, bootId: () => 'boot-1',
    enqueue: (_c, body) => { jobs++; void body(() => {}); return jobs; },
    ...over,
  };
  return { env, calls, audits, state: () => st, jobs: () => jobs };
}

test('manager: a connectivity check finds firmware and the NVIDIA driver; firmware installs itself and its driver reloads', async () => {
  const m = managerEnv();
  const d = new DriverManager(m.env);
  const r = await d.check('connectivity');
  assert.deepEqual(r.offers.map((o) => o.id).sort(), ['fw:firmware-iwlwifi', 'fw:firmware-realtek', 'gpu:nvidia-driver']);
  assert.deepEqual(r.auto_installed.sort(), ['fw:firmware-iwlwifi', 'fw:firmware-realtek']);
  await new Promise((res) => setImmediate(res));
  assert.ok(m.calls.some((c) => c.startsWith('apt-get -y -q') && c.endsWith('install -- firmware-iwlwifi')));
  assert.ok(m.calls.includes('modprobe -r iwlwifi') && m.calls.includes('modprobe iwlwifi'));
  assert.ok(!m.calls.some((c) => c.includes('nvidia-driver')), 'the GPU driver waits for a person');
  // the same day: no second check
  m.calls.length = 0;
  await d.check('connectivity');
  assert.equal(m.calls.length, 0);
});

test('manager: policy off → no search, state off', async () => {
  const m = managerEnv({ policy: () => ({ drivers_online_search: false }) });
  const r = await new DriverManager(m.env).check('connectivity');
  assert.equal(r.state, 'off'); assert.equal(m.calls.length, 0);
});

test('manager: metered → no fwupd refresh, no automatic install of unknown sizes', async () => {
  const m = managerEnv({ metered: async () => true });
  const r = await new DriverManager(m.env).check('manual');
  assert.equal(r.metered, true); assert.deepEqual(r.auto_installed, []);
  assert.ok(!m.calls.some((c) => c.startsWith('fwupdmgr refresh')));
});

test('manager: Secure Boot GPU install asks MokManager to enrol the DKMS key with a one-time password', async () => {
  const m = managerEnv({ secureBoot: () => true });
  const d = new DriverManager(m.env);
  await d.check('manual');
  d.install(1000, ['gpu:nvidia-driver']);
  await new Promise((res) => setTimeout(res, 10));
  assert.ok(m.calls.some((c) => c === 'mokutil --import /var/lib/dkms/mok.pub --hash-file /var/lib/worksuite-package-service/mok.hash'));
  // Not in the report every local user can read (GetDrivers, DriversChanged), only through the admin call.
  assert.deepEqual(d.status().mok, { pending: true });
  assert.ok(!JSON.stringify(d.status()).includes((m.state() as { mok: { password: string } }).mok.password));
  const pw = await d.mokPassword();
  assert.match(pw!, /^\d{8}$/);
  // After the next boot the password is gone.
  const next = new DriverManager({ ...m.env, bootId: () => 'boot-2' });
  assert.equal(next.status().mok, undefined);
  assert.equal(await next.mokPassword(), null);
  assert.equal((m.state() as { gpu?: { pending_boot?: boolean } }).gpu?.pending_boot, true);
  assert.match(mokPassword(), /^\d{8}$/);
});

test('manager: failed first boot after the nvidia driver → purge back to nouveau', async () => {
  const m = managerEnv({ installed: (p) => p === 'nvidia-driver' });
  m.env.save({ gpu: { pending_boot: true } });
  const d = new DriverManager(m.env);
  assert.equal(await d.gpuBootCheck(false, false), true);
  assert.ok(m.calls.some((c) => c.startsWith('apt-get -y -q purge -- nvidia-driver')));
  assert.equal(d.status().gpu_fallback, true);
  assert.equal(await d.gpuBootCheck(false, false), false, 'only once');
});

test('MOK password: only through the polkit-guarded call; cleared once the key is enrolled', async () => {
  const { ACTIONS } = await import('../src/dbus.ts');
  assert.equal(ACTIONS.GetMokPassword, 'lk.worksuite.drivers.install');
  assert.equal(ACTIONS.GetDrivers, null);
  const m = managerEnv({ secureBoot: () => true });
  const d = new DriverManager(m.env);
  await d.check('manual');
  d.install(1000, ['gpu:nvidia-driver']);
  await new Promise((res) => setTimeout(res, 10));
  const enrolled = new DriverManager({ ...m.env, run: async (cmd, args) => ({ code: 0, stdout: cmd === 'mokutil' && args[0] === '--test-key' ? '/var/lib/dkms/mok.pub is already enrolled' : '', stderr: '' }) });
  assert.equal(await enrolled.mokPassword(), null);
  assert.equal((m.state() as { mok?: unknown }).mok, undefined);
  assert.equal(enrolled.status().mok, undefined);
});

// #45: real-world install path (a fresh install has no package lists; apt prints warnings before its error; progress).
test('install: refreshes the package lists, downloads then installs with progress, records the installed version', async () => {
  const phases: [string, number][] = [];
  const m = managerEnv({
    enqueue: (_c, body) => { void body((ph, pct) => phases.push([ph, pct])); return 1; },
    runLines: async (cmd, args, onLine) => {
      m.calls.push([cmd, ...args].join(' '));
      if (args.includes('--download-only')) for (const l of ['dlstatus:1:0:Retrieving file 1 of 1', 'dlstatus:1:50:Retrieving file 1 of 1', 'dlstatus:1:100:Retrieving file 1 of 1']) onLine(l);
      else for (const l of ['Selecting previously unselected package firmware-iwlwifi.', 'pmstatus:firmware-iwlwifi:20:Preparing', 'pmstatus:firmware-iwlwifi:100:Installed firmware-iwlwifi']) onLine(l);
      return { code: 0, stdout: '', stderr: '' };
    },
    version: (p) => (p === 'firmware-iwlwifi' ? '20250410-2' : null),
    policy: () => ({ drivers_auto_install: false }),
  });
  const d = new DriverManager(m.env);
  await d.check('manual');
  d.install(1000, ['fw:firmware-iwlwifi']);
  await new Promise((res) => setTimeout(res, 10));
  const apt = m.calls.filter((c) => c.startsWith('apt-get'));
  assert.equal(apt[0], 'apt-get -q update');
  assert.match(apt[1], /--download-only install -- firmware-iwlwifi$/);
  assert.match(apt[2], /--no-download install -- firmware-iwlwifi$/);
  assert.deepEqual(phases.map((p) => p[0].split('|')[1]).filter((x, i, a) => a.indexOf(x) === i), ['refreshing', 'downloading', 'installing', 'done']);
  const pcts = phases.map((p) => p[1]);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), 'progress only rises');
  assert.ok(phases.some(([ph, p]) => ph.endsWith('|downloading') && p > 5 && p < 60));
  const r = d.status();
  assert.ok(!r.offers.some((o) => o.id === 'fw:firmware-iwlwifi'));
  assert.deepEqual(r.installed?.map((x) => [x.id, x.version]), [['fw:firmware-iwlwifi', '20250410-2']]);
});

test('install: a failure carries apt\'s E: line (not the first warning) and leaves the offer for a retry', async () => {
  const m = managerEnv({
    policy: () => ({ drivers_auto_install: false }),
    run: async (cmd, args) => {
      m.calls.push([cmd, ...args].join(' '));
      if (cmd === 'apt-get' && args.includes('install')) return { code: 100, stdout: '', stderr: 'W: Target Packages (non-free-firmware/binary-amd64/Packages) is configured multiple times in /etc/apt/sources.list:1 and /etc/apt/sources.list.d/debian.sources:1\nE: Unable to locate package firmware-iwlwifi\n' };
      return { code: cmd === 'isenkram-lookup' || cmd === 'fwupdmgr' ? 2 : 0, stdout: '', stderr: '' };
    },
  });
  let failure: unknown = null;
  m.env.enqueue = (_c, body) => { body(() => {}).catch((e) => { failure = e; }); return 1; };
  const d = new DriverManager(m.env);
  await d.check('manual');
  d.install(1000, ['fw:firmware-iwlwifi']);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal((failure as Error).message, 'apt-get: E: Unable to locate package firmware-iwlwifi');
  assert.ok(d.status().offers.some((o) => o.id === 'fw:firmware-iwlwifi'), 'still offered: Try again works');
});

test('install: a restart notice stays until the next boot', async () => {
  const m = managerEnv({ policy: () => ({ drivers_auto_install: false }) });
  const d = new DriverManager(m.env);
  await d.check('manual');
  d.install(1000, ['gpu:nvidia-driver']);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(d.status().restart_required, true);
  assert.equal(new DriverManager(m.env).status().restart_required, true);
  assert.equal(new DriverManager({ ...m.env, bootId: () => 'boot-2' }).status().restart_required, false);
});

test('apt status lines and errors', () => {
  assert.deepEqual(parseAptStatus('dlstatus:2:48.5:Retrieving file 2 of 3'), { stage: 'download', pct: 48.5 });
  assert.deepEqual(parseAptStatus('pmstatus:firmware-iwlwifi:66.6667:Installed firmware-iwlwifi (20250410-2)'), { stage: 'install', pct: 66.6667 });
  assert.equal(parseAptStatus('Get:1 https://deb.debian.org/debian trixie/non-free-firmware amd64 firmware-iwlwifi all 20250410-2 [9,342 kB]'), null);
  assert.equal(aptError('W: Some index files failed to download.\nE: Failed to fetch https://deb.debian.org/debian/pool/x.deb  Temporary failure resolving \'deb.debian.org\''), 'E: Failed to fetch https://deb.debian.org/debian/pool/x.deb  Temporary failure resolving \'deb.debian.org\'');
  assert.equal(aptError('dpkg: error processing package nvidia-kernel-dkms (--configure):\n installed post-installation script returned error exit status 10'), 'dpkg: error processing package nvidia-kernel-dkms (--configure):');
});

test('sources: live-build\'s unsigned sources.list duplicates are disabled, anything else is left alone', () => {
  const deb822 = readFileSync(new URL('../../../live-build/config/includes.chroot/etc/apt/sources.list.d/debian.sources', import.meta.url), 'utf8');
  const lb = 'deb https://deb.debian.org/debian/ trixie main contrib non-free non-free-firmware\ndeb https://security.debian.org/debian-security/ trixie-security main contrib non-free non-free-firmware\ndeb https://deb.debian.org/debian/ trixie-updates main contrib non-free non-free-firmware\n';
  const out = tidyLegacySources(lb, [deb822])!;
  assert.deepEqual(checkSources(out, '/etc/apt/sources.list'), []);
  assert.ok(checkSources(lb, '/etc/apt/sources.list').length > 0, 'it did fail the sources check before');
  assert.equal(tidyLegacySources(out, [deb822]), null, 'idempotent');
  const other = 'deb http://example.com/debian trixie main\n';
  assert.equal(tidyLegacySources(other, [deb822]), null);
  assert.equal(tidyLegacySources('deb https://deb.debian.org/debian trixie main\n', []), null, 'no signed copy: kept');
});

// #59: what live-build 20250505 (trixie) really writes to the image's /etc/apt/sources.list (functions/sourcelist.sh,
// binary pass with --parent-mirror-binary): a deb-src line after every deb line. Those stayed unsigned after #45's tidy
// and failed every driver install with "/etc/apt/sources.list: missing Signed-By".
const LB_SOURCES_LIST = ['https://deb.debian.org/debian/ trixie', 'https://security.debian.org/debian-security/ trixie-security', 'https://deb.debian.org/debian/ trixie-updates']
  .flatMap((a) => [`deb ${a} main contrib non-free non-free-firmware`, `deb-src ${a} main contrib non-free non-free-firmware`]).join('\n') + '\n';

test('sources: live-build\'s deb-src lines are disabled too, so the sources check passes on an installed system (#59)', () => {
  const deb822 = readFileSync(new URL('../../../live-build/config/includes.chroot/etc/apt/sources.list.d/debian.sources', import.meta.url), 'utf8');
  assert.equal(checkSources(LB_SOURCES_LIST, '/etc/apt/sources.list').length, 6, 'every line fails before');
  const out = tidyLegacySources(LB_SOURCES_LIST, [deb822])!;
  assert.deepEqual(checkSources(out, '/etc/apt/sources.list'), []);
  assert.equal(out.split('\n').filter((l) => /^deb/.test(l)).length, 0);
  assert.equal(tidyLegacySources(out, [deb822]), null, 'idempotent');
  // A deb-src line for an archive no signed file covers is left for the check to refuse.
  assert.equal(tidyLegacySources('deb-src https://deb.debian.org/debian trixie-backports main\n', [deb822]), null);
});

// #69: "A software source on this computer isn't signed or approved" for tp-smapi-dkms on an installed system whose
// sources were all Debian's: a deb822 stanza with an embedded key, a national mirror, an http:// line, a cdrom line.
test('sources: Debian\'s own sources are recognised however they are written (#69)', () => {
  const embedded = 'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nComponents: main\nSigned-By:\n -----BEGIN PGP PUBLIC KEY BLOCK-----\n .\n mQINBF...\n -----END PGP PUBLIC KEY BLOCK-----\n';
  assert.deepEqual(checkSources(embedded, '/etc/apt/sources.list.d/debian.sources'), [], 'embedded Signed-By key block');
  const mirror = 'Types: deb deb-src\n# national mirror\nURIs: http://ftp.lk.debian.org/debian/\nSuites: trixie trixie-updates\nComponents: main contrib\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\nEnabled: yes\n';
  assert.deepEqual(checkSources(mirror, '/etc/apt/sources.list.d/debian.sources'), [], '*.debian.org mirror, .pgp keyring');
  const pinned = 'deb [arch=amd64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://mirror.example.lk/debian trixie main\n';
  assert.deepEqual(checkSources(pinned, '/etc/apt/sources.list'), [], 'any mirror pinned to Debian\'s archive keyring');
  assert.deepEqual(checkSources('deb cdrom:[Debian GNU/Linux 13.1.0 _Trixie_ - Official amd64 DVD Binary-1]/ trixie contrib main\n', '/etc/apt/sources.list'), [], 'installation disc');
  // Still refused: a third-party archive, an unsigned one, signature checks turned off, a key that isn't there.
  assert.match(checkSources('deb [signed-by=/usr/share/keyrings/x.gpg] https://ppa.example.com/x trixie main\n', 'x.list').join(), /not an approved source/);
  // A *.debian.org host that is not the archive (people.debian.org) with its own key is a third-party archive too;
  // a Debian mirror is approved through Debian's keyring only (#69 follow-up).
  assert.match(checkSources('deb [signed-by=/etc/apt/keyrings/someone.gpg] https://people.debian.org/~someone/repo trixie main\n', 'p.list').join(), /people\.debian\.org is not an approved source/);
  assert.match(checkSources(mirror.replace('/usr/share/keyrings/debian-archive-keyring.pgp', '/etc/apt/keyrings/other.gpg'), 'd.sources').join(), /ftp\.lk\.debian\.org is not an approved source/);
  assert.match(checkSources('deb http://ftp.lk.debian.org/debian/ trixie main\n', 'u.list').join(), /missing Signed-By/, 'unsigned mirror line (not yet pinned by tidyLegacySources) is refused');
  assert.match(checkSources('deb [trusted=yes signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main\n', 'x.list').join(), /trusted=yes turns off signature checks/);
  assert.match(checkSources('Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nTrusted: yes\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n', 'd.sources').join(), /trusted=yes/);
  assert.deepEqual(checkSources(mirror, 'd.sources', [], (k) => k.endsWith('.pgp')), []);
  assert.match(checkSources(mirror, 'd.sources', [], () => false).join(), /Signed-By key \/usr\/share\/keyrings\/debian-archive-keyring\.pgp is not installed/);
  assert.deepEqual(checkSources(mirror.replace('Enabled: yes', 'Enabled: false').replace('trixie trixie-updates', 'sid'), 'd.sources'), [], 'Enabled: false is off too');
});

test('sources: unsigned Debian lines are pinned to Debian\'s keyring; http and https lines a stanza covers are disabled (#69)', () => {
  const deb822 = readFileSync(new URL('../../../live-build/config/includes.chroot/etc/apt/sources.list.d/debian.sources', import.meta.url), 'utf8');
  const list = 'deb http://deb.debian.org/debian trixie main contrib non-free non-free-firmware\ndeb http://ftp.lk.debian.org/debian/ trixie main\ndeb http://example.com/debian trixie main\n';
  const K = '/usr/share/keyrings/debian-archive-keyring.pgp';
  const out = tidyLegacySources(list, [deb822], K)!;
  const lines = out.split('\n');
  assert.match(lines[0], /^# deb http:\/\/deb\.debian\.org/, 'same archive as the https stanza');
  assert.equal(lines[1], `deb [signed-by=${K}] http://ftp.lk.debian.org/debian/ trixie main`);
  assert.equal(lines[2], 'deb http://example.com/debian trixie main', 'not Debian: left for the check to refuse');
  assert.deepEqual(checkSources(lines.slice(0, 2).join('\n'), '/etc/apt/sources.list'), []);
  assert.equal(tidyLegacySources(out, [deb822], K), null, 'idempotent');
  assert.equal(tidyLegacySources('deb http://ftp.lk.debian.org/debian/ trixie main\n', [], undefined), null, 'no keyring installed: left alone');
});

test('service: driver jobs tidy sources.list before checking it (it can change after the service started)', async () => {
  const { PackageService } = await import('../src/service.ts');
  const deb822 = readFileSync(new URL('../../../live-build/config/includes.chroot/etc/apt/sources.list.d/debian.sources', import.meta.url), 'utf8');
  let list = LB_SOURCES_LIST;
  const svc = new PackageService({
    runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, policy: () => null, power: () => ({ ac: true, battery: null }), freeBytes: () => 50e9, audit() {},
    sources: () => [['/etc/apt/sources.list', list], ['/etc/apt/sources.list.d/debian.sources', deb822]],
    tidySources: () => { list = tidyLegacySources(list, [deb822]) ?? list; },
  });
  let ran = false;
  const id = svc.driverJob(1000, async () => { ran = true; });
  const job = await new Promise<{ state: string; error?: string }>((res) => svc.on('finished', (j) => { if (j.id === id) res(j); }));
  assert.equal(job.state, 'success', job.error); assert.equal(ran, true);
});

test('install: each offer installs on its own; a failed one is reported per offer with its step and error (#59)', async () => {
  const phases: string[] = [];
  let failure: Error | null = null;
  const m = managerEnv({
    policy: () => ({ drivers_auto_install: false }),
    run: async (cmd, args) => {
      m.calls.push([cmd, ...args].join(' '));
      return { code: cmd === 'isenkram-lookup' || cmd === 'fwupdmgr' ? 2 : 0, stdout: '', stderr: '' };
    },
    runLines: async (cmd, args) => {
      m.calls.push([cmd, ...args].join(' '));
      if (args.includes('firmware-iwlwifi') && args.includes('--download-only')) return { code: 100, stdout: '', stderr: 'E: Package \'firmware-iwlwifi\' has no installation candidate\n' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  m.env.enqueue = (_c, body) => { body((ph) => phases.push(ph)).catch((e) => { failure = e; }); return 1; };
  const d = new DriverManager(m.env);
  await d.check('manual');
  d.install(1000, ['fw:firmware-iwlwifi', 'fw:firmware-realtek']);
  await new Promise((res) => setTimeout(res, 10));
  assert.ok(phases.includes('fw:firmware-iwlwifi|failed') && phases.includes('fw:firmware-realtek|done'), 'the second offer still installs');
  assert.ok(m.calls.some((c) => c.endsWith('--no-download install -- firmware-realtek')));
  assert.equal(failure!.message, 'apt-get: E: Package \'firmware-iwlwifi\' has no installation candidate');
  const r = d.status();
  assert.deepEqual(r.failed?.map((f) => [f.id, f.step, f.error]), [['fw:firmware-iwlwifi', 'downloading', 'apt-get: E: Package \'firmware-iwlwifi\' has no installation candidate']]);
  assert.deepEqual(r.offers.map((o) => o.id).filter((x) => x.startsWith('fw:')), ['fw:firmware-iwlwifi'], 'the failed one stays offered');
  assert.deepEqual(r.installed?.map((x) => x.id), ['fw:firmware-realtek']);
  // Trying again and succeeding clears its error.
  m.env.runLines = async () => ({ code: 0, stdout: '', stderr: '' });
  failure = null;
  d.install(1000, ['fw:firmware-iwlwifi']);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(failure, null); assert.equal(d.status().failed, undefined);
});

test('install: when the package lists could not be refreshed, that error is the one shown (#59)', async () => {
  let failure: Error | null = null;
  const m = managerEnv({
    policy: () => ({ drivers_auto_install: false }),
    run: async (cmd, args) => {
      m.calls.push([cmd, ...args].join(' '));
      if (cmd === 'apt-get' && args.includes('update')) return { code: 100, stdout: '', stderr: 'W: Some index files failed to download. They have been ignored, or old ones used instead.\nE: Failed to fetch https://deb.debian.org/debian/dists/trixie/InRelease  Temporary failure resolving \'deb.debian.org\'\n' };
      if (cmd === 'apt-get') return { code: 100, stdout: '', stderr: 'E: Unable to locate package firmware-realtek\n' };
      return { code: cmd === 'isenkram-lookup' || cmd === 'fwupdmgr' ? 2 : 0, stdout: '', stderr: '' };
    },
  });
  m.env.enqueue = (_c, body) => { body(() => {}).catch((e) => { failure = e; }); return 1; };
  const d = new DriverManager(m.env);
  await d.check('manual');
  d.install(1000, ['fw:firmware-realtek']);
  await new Promise((res) => setTimeout(res, 10));
  assert.match(failure!.message, /^apt-get update: E: Failed to fetch .* Temporary failure resolving 'deb\.debian\.org'$/);
  assert.equal(d.status().failed?.[0].id, 'fw:firmware-realtek');
});

test('unit: network and DNS stay reachable for apt; no device allow-list that would break update-initramfs (#59)', () => {
  const unit = readFileSync(new URL('../systemd/worksuite-package-service.service', import.meta.url), 'utf8');
  const set = (k: string) => unit.split('\n').filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));
  assert.deepEqual(set('PrivateNetwork'), []); assert.deepEqual(set('IPAddressDeny'), []);
  const fams = set('RestrictAddressFamilies').join(' ').split(/\s+/);
  for (const f of ['AF_UNIX', 'AF_INET', 'AF_INET6', 'AF_NETLINK']) assert.ok(fams.includes(f), f);
  // ProtectClock= implies DeviceAllow=char-rtc, i.e. a closed device list: /dev/mapper/control and disks become unreachable.
  assert.deepEqual(set('ProtectClock'), []); assert.deepEqual(set('DeviceAllow'), []); assert.deepEqual(set('PrivateDevices'), []);
  assert.match(set('CapabilityBoundingSet').join(' '), /^~CAP_SYS_TIME CAP_WAKE_ALARM$/);
  assert.ok(!/^ProtectSystem=strict/m.test(unit) && /^ReadWritePaths=.*\/etc\b/m.test(unit), 'dpkg can write /etc and /usr');
});

test('#59: unreachable package servers → state offline (never "up to date"); installed() read once per check', async () => {
  let refreshed = 0, asked = 0;
  const m = managerEnv({ archiveReachable: async () => false, refreshInstalled: () => { refreshed++; }, installed: (p) => { if (p === 'nvidia-driver') asked++; return false; } });
  const r = await new DriverManager(m.env).check('manual');
  assert.equal(r.state, 'offline');
  assert.equal(refreshed, 1);
  assert.equal(asked, 1, 'nvidia-driver is looked up once per check, not once per device');
  const ok = managerEnv({ archiveReachable: async () => true });
  assert.equal((await new DriverManager(ok.env).check('manual')).state, 'idle');
});

test('#59: parseInstalled keeps only installed ("ii") packages, without the architecture', () => {
  const s = parseInstalled('nvidia-driver\tun \nfirmware-iwlwifi\tii \nlibc6:amd64\tii \nfoo\trc \n');
  assert.deepEqual([...s].sort(), ['firmware-iwlwifi', 'libc6']);
});
