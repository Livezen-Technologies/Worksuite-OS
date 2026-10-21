#!/bin/sh
# WorkSuite Security scans (#20, #64) on an installed image: ClamAV and its updater are in the image (the build
# installs no recommends, so they must be listed), the updater is enabled (otherwise /var/lib/clamav stays empty and
# clamscan exits 2 before scanning anything), and the device agent may start the scan unit and stop it.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
list="$root/live-build/config/package-lists/worksuite.list.chroot"
hook="$root/live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot"
aa="$root/security/apparmor/worksuite-device-agent"
fail() { echo "not ok - $1"; exit 1; }
for p in clamav clamav-freshclam; do grep -qx "$p" "$list" || fail "$p not in the image package list"; done
grep -qx 'systemctl enable clamav-freshclam.service' "$hook" || fail "clamav-freshclam.service not enabled: no virus definitions, scans fail"
grep -q '/usr/bin/systemd-run rix' "$aa" || fail "AppArmor profile does not allow systemd-run (scans run as a transient unit)"
grep -q '/usr/bin/{systemctl' "$aa" || fail "AppArmor profile does not allow systemctl (cancel stops the scan unit)"
grep -q "SCAN_UNIT = 'worksuite-av-scan.service'" "$root/services/device-agent/src/securityHost.ts" || fail "scan unit name changed"
for m in StartSecurityScan CancelSecurityScan UpdateSecurityDefinitions; do
  grep -q "<method name=\"$m\"" "$root/services/device-agent/dbus/lk.worksuite.DeviceAgent1.xml" || fail "$m missing from the D-Bus interface"
done
echo "ok - antivirus image setup"
