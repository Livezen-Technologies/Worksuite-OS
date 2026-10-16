// WSOS-MDM-001: hardware inventory from a fake sysfs tree, and the update status published by the package service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectHardware, readUpdateStatus } from '../src/inventory.ts';

function tree(files: Record<string, string>, links: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ws-sysfs-'));
  for (const [p, v] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), v + '\n'); }
  for (const [p, target] of Object.entries(links)) { mkdirSync(dirname(join(root, p)), { recursive: true }); symlinkSync(target, join(root, p)); }
  return root;
}

test('collects DMI, disks, adapters, GPUs and batteries; skips virtual devices', () => {
  const root = tree({
    'sys/class/dmi/id/sys_vendor': 'LENOVO', 'sys/class/dmi/id/product_name': '21CB', 'sys/class/dmi/id/product_serial': 'PF3XYZ',
    'sys/class/dmi/id/bios_version': 'N3AET75W', 'sys/class/dmi/id/board_vendor': 'LENOVO', 'sys/class/dmi/id/board_name': '21CBCTO1WW',
    'sys/firmware/efi/fw_platform_size': '64',
    'sys/block/nvme0n1/size': '1000215216', 'sys/block/nvme0n1/queue/rotational': '0', 'sys/block/nvme0n1/removable': '0', 'sys/block/nvme0n1/device/model': 'SAMSUNG MZVL2512',
    'sys/block/sda/size': '60062500', 'sys/block/sda/queue/rotational': '0', 'sys/block/sda/removable': '1', 'sys/block/sda/device/model': 'USB DISK',
    'sys/block/loop0/size': '1000', 'sys/block/zram0/size': '1000',
    'sys/class/net/lo/address': '00:00:00:00:00:00',
    'sys/class/net/wlp0s20f3/address': 'aa:bb:cc:dd:ee:ff', 'sys/class/net/wlp0s20f3/type': '1', 'sys/class/net/wlp0s20f3/wireless/x': '',
    'sys/class/net/wlp0s20f3/device/vendor': '0x8086',
    'sys/class/net/enp0s31f6/address': '11:22:33:44:55:66', 'sys/class/net/enp0s31f6/type': '1', 'sys/class/net/enp0s31f6/device/vendor': '0x8086',
    'sys/class/net/wg0/type': '65534',
    'sys/class/drm/card0/device/vendor': '0x8086', 'sys/class/drm/card0/device/device': '0x46a6', 'sys/class/drm/card0-eDP-1/status': 'connected',
    'sys/class/power_supply/AC/type': 'Mains',
    'sys/class/power_supply/BAT0/type': 'Battery', 'sys/class/power_supply/BAT0/energy_full_design': '57000000', 'sys/class/power_supply/BAT0/energy_full': '51300000', 'sys/class/power_supply/BAT0/cycle_count': '212',
  }, {
    'sys/class/net/wlp0s20f3/device/driver': '../../../bus/pci/drivers/iwlwifi',
    'sys/class/drm/card0/device/driver': '../../../bus/pci/drivers/i915',
  });
  const hw = collectHardware(root);
  assert.equal(hw.vendor, 'LENOVO');
  assert.equal(hw.model, '21CB');
  assert.equal(hw.serial, 'PF3XYZ');
  assert.equal(hw.bios_version, 'N3AET75W');
  assert.equal(hw.board, 'LENOVO 21CBCTO1WW');
  assert.equal(hw.firmware, 'uefi');
  assert.deepEqual(hw.disks.map((d) => d.name), ['nvme0n1', 'sda']);
  assert.equal(hw.disks[0].size_bytes, 1000215216 * 512);
  assert.equal(hw.disks[0].transport, 'nvme');
  assert.equal(hw.disks[1].removable, true);
  assert.deepEqual(hw.network.map((n) => [n.name, n.kind, n.driver]), [['enp0s31f6', 'ethernet', null], ['wlp0s20f3', 'wifi', 'iwlwifi']]);
  assert.deepEqual(hw.gpus, [{ pci_vendor: '0x8086', pci_device: '0x46a6', driver: 'i915' }]);
  assert.deepEqual(hw.batteries, [{ name: 'BAT0', design_wh: 57, full_wh: 51.3, health_percent: 90, cycle_count: 212 }]);
});

test('an empty tree reports nothing rather than guesses', () => {
  const hw = collectHardware(tree({}));
  assert.deepEqual(hw, { vendor: null, model: null, serial: null, bios_version: null, board: null, firmware: 'bios', disks: [], network: [], gpus: [], batteries: [] });
});

test('charge-based batteries are converted with the design voltage', () => {
  const hw = collectHardware(tree({
    'sys/class/power_supply/BAT1/type': 'Battery', 'sys/class/power_supply/BAT1/charge_full_design': '5000000',
    'sys/class/power_supply/BAT1/charge_full': '4000000', 'sys/class/power_supply/BAT1/voltage_min_design': '11400000',
  }));
  assert.deepEqual(hw.batteries[0], { name: 'BAT1', design_wh: 57, full_wh: 45.6, health_percent: 80, cycle_count: null });
});

test('update status comes from the package service status file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-upd-'));
  const p = join(dir, 'update-status.json');
  assert.equal(readUpdateStatus(p), null);
  writeFileSync(p, JSON.stringify({ state: 'ready_to_restart', installed: '1.0.1', version: '1.0.2', last_check: 5, reason: null, mandatory: false }));
  assert.deepEqual(readUpdateStatus(p), { state: 'ready_to_restart', installed: '1.0.1', version: '1.0.2', last_check: 5, reason: null });
  writeFileSync(p, '{"nope":1}');
  assert.equal(readUpdateStatus(p), null);
});
