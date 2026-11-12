// Install-time hardware report (installer, chrooted into the new system): per-device status from the real sysfs scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildReport, parseDeviceNames } from '../src/hwreport.ts';
import type { ScannedDevice } from '../src/drivers.ts';

const wifi: ScannedDevice = { id: 'pci:0000:00:14.3', bus: 'pci', modaliases: ['pci:v00008086d0000A0F0sv00008086sd00000244bc02sc80i00'], driver: 'iwlwifi', module: 'iwlwifi', cls: '0x028000', vendor: '8086', product: 'a0f0' };
const gpu: ScannedDevice = { id: 'pci:0000:01:00.0', bus: 'pci', modaliases: ['pci:v000010DEd00002520sv*'], driver: 'nouveau', module: 'nouveau', cls: '0x030000', vendor: '10de', product: '2520' };
const nic: ScannedDevice = { id: 'pci:0000:00:1f.6', bus: 'pci', modaliases: ['pci:v00008086d000015FCsv*'], driver: 'e1000e', module: 'e1000e', cls: '0x020000', vendor: '8086', product: '15fc' };
const log = 'iwlwifi 0000:00:14.3: Direct firmware load for iwlwifi-QuZ-a0-hr-b0-77.ucode failed with error -2\n';

test('hwreport: missing firmware and approval-only drivers are named per device; nothing is guessed', () => {
  const r = buildReport([wifi, gpu, nic], log, () => false, { kernel: '6.12.111+deb13-amd64', arch: 'amd64', now: new Date(0) });
  const by = Object.fromEntries(r.devices.map((d) => [d.id, d.status]));
  assert.equal(by['pci:0000:00:14.3'], 'missing_firmware');
  assert.equal(by['pci:0000:01:00.0'], 'optional_driver');
  assert.equal(by['pci:0000:00:1f.6'], 'working');
  assert.deepEqual(r.missing_firmware.map((f) => f.file), ['iwlwifi-QuZ-a0-hr-b0-77.ucode']);
  assert.deepEqual(r.needs_approval.map((a) => a.packages[0]), ['nvidia-driver']);
  assert.deepEqual(r.summary, { total: 3, working: 1, missing_firmware: 1, no_driver: 0, optional_driver: 1 });
});

test('hwreport: firmware already on the installed system is not reported missing', () => {
  const r = buildReport([wifi], log, (f) => f.startsWith('iwlwifi-'), { kernel: 'k', arch: 'amd64' });
  assert.equal(r.devices[0].status, 'working');
  assert.deepEqual(r.missing_firmware, []);
});

test('hwreport: device names from lspci -nn -mm and lsusb', () => {
  const m = parseDeviceNames('00:14.3 "Network controller [0280]" "Intel Corporation [8086]" "Wi-Fi 6 AX201 [a0f0]" -r00 "Intel Corporation [8086]" "Device [0244]"\n',
    'Bus 001 Device 003: ID 8087:0026 Intel Corp. AX201 Bluetooth\n');
  assert.equal(m.get('8086:a0f0'), 'Intel Corporation Wi-Fi 6 AX201');
  assert.equal(m.get('8087:0026'), 'Intel Corp. AX201 Bluetooth');
});

test('hwreport: the CLI runs against this machine and writes a report', () => {
  const out = `${process.env.TMPDIR ?? '/tmp'}/hw-${process.pid}.json`;
  const text = execFileSync(process.execPath, ['--no-warnings', new URL('../src/hwreport.ts', import.meta.url).pathname, '--out', out], { encoding: 'utf8' });
  assert.match(text, /^hardware: \d+ devices/);
});
