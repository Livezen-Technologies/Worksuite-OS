# Networking: VPN and captive portals (WSOS-INT-001)

## WireGuard and OpenVPN

Settings › Network › VPN lists every NetworkManager VPN profile: the organization's managed "WorkSuite VPN"
(device agent, `services/device-agent/src/vpn.ts`), plus WireGuard `.conf` and OpenVPN `.ovpn` files the user
imports. Policy `user_vpn: block` hides both import buttons, refuses imports and OpenVPN connects in the shell, and
the device agent deletes every non-managed VPN profile (WireGuard and NM VPN plugins, OpenVPN included).

OpenVPN (`network-manager-openvpn`, `shell/electron/openvpn.ts`):

- The file is validated before nmcli sees it. Refused: `up`, `down`, `route-up`, `route-pre-down`, `ipchange`,
  `tls-verify`, `auth-user-pass-verify`, `client-connect`/`-disconnect`, `learn-address`, `plugin`, `config`,
  logging/pid/chroot/daemon directives, and `script-security` above 1. Credentials in the file
  (`auth-user-pass <file>`, `<auth-user-pass>`, `askpass <file>`) are refused too.
- Certificates and keys, inline (`<ca>`) or referenced next to the `.ovpn` (no `..` or absolute paths), are copied to
  `~/.local/share/worksuite/vpn/<name>/` (0700 directory, 0600 files) and the config is rewritten to point there
  before `nmcli connection import type openvpn file …`. Removing the profile removes the folder.
- Imported profiles never autoconnect. For password logins the shell asks for user name and password on every
  connect: the user name goes to `nmcli connection edit` on stdin, the password to `nmcli --ask connection up` on
  stdin, never on a command line; `password-flags=2` means NetworkManager does not store it.

## Captive portals

`/etc/NetworkManager/conf.d/20-worksuite-connectivity.conf` enables NetworkManager's connectivity check against
`http://network-test.debian.org/nm` (expects `NetworkManager is online`, every 300 s). Override it with a later
conf.d file to use your own endpoint.

The shell polls `nmcli -t networking connectivity` every 15 s (`shell/electron/connectivity.ts`, state machine in
`portalStep`). On `portal` it shows a notification and opens a **Sign in to network** window:

- a sandboxed `BrowserWindow` in its own in-memory partition (`ws-portal-<time>`, nothing persisted, not shared with
  the shell or the WorkSuite app sessions), no preload, no Node, `contextIsolation`, no `<webview>`;
- navigation and redirects allowed only to `http:`/`https:` URLs without embedded credentials; pop-ups load in the
  same window; permission requests, permission checks and downloads are denied;
- closed automatically when connectivity becomes `full` (with a "Connected" notification); the partition's storage
  is cleared when it closes.

### Kill switch

When the managed VPN's kill switch is loaded (the agent's nftables table `worksuite_vpn_killswitch`; the shell checks
`/run/worksuite-device-agent/vpn-killswitch.nft`), all traffic outside the tunnel is dropped, so the portal cannot
load. No temporary exception is opened. Allowing "the current gateway for 5 minutes" was considered and rejected:

- the portal page is usually not served by the gateway itself, and reaching it also needs DNS on the untrusted
  network, so the exception would have to allow arbitrary hosts and DNS, which is exactly what the kill switch exists
  to stop;
- the shell runs as the user and cannot change nftables; giving it a way to punch holes would let any user-level
  compromise disable the organization's kill switch.

Instead the user gets a clear notification ("Network sign-in blocked … use another network or contact your IT
team"). An organization that wants portal access can turn the kill switch off for the device in the admin console.
