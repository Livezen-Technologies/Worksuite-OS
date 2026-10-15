#!/bin/sh
# WSOS-AUTH-002: automatic sign-in is off in the shipped greetd config and only an explicit kiosk (policy) or
# personal-device configuration turns it on.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=$ROOT/services/session/bin
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }
mkdir -p "$T/stub"
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$T/stub/$1"; chmod +x "$T/stub/$1"; }
PATH="$T/stub:$PATH"; export PATH
stub getent 'case "$2" in kiosk|nimali|hasarinda) echo "$2:x:1000:1000::/home/$2:/bin/bash";; *) exit 2;; esac'
stub id 'case "$2" in hasarinda) echo "hasarinda sudo";; *) echo "$2";; esac'
stub logger ':'

# The image's greetd config (from the build hook) has no initial_session.
HOOK=$ROOT/live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot
sed -n "/^cat > \/etc\/greetd\/config.toml <<'CONF'$/,/^CONF$/p" "$HOOK" | sed '1d;$d' > "$T/config.toml"
grep -q '^\[default_session\]' "$T/config.toml" && ok "shipped config has the greeter session" || bad "shipped config has the greeter session"
grep -q 'initial_session' "$T/config.toml" && bad "no autologin by default" || ok "no autologin by default"
grep -q 'worksuite-session' "$T/config.toml" && ok "WorkSuite session is the default session" || bad "WorkSuite session is the default session"

export WORKSUITE_GREETD_CONF="$T/config.toml" WORKSUITE_AGENT_STATE="$T/state.json"
A="sh $BIN/worksuite-autologin"
[ "$($A status)" = disabled ] && ok "status: disabled" || bad "status: disabled"
$A enable nimali >/dev/null 2>&1 && bad "a mode is required" || ok "a mode is required"
$A enable --personal hasarinda >/dev/null 2>&1 && bad "administrators refused" || ok "administrators refused"
$A enable --personal root >/dev/null 2>&1 && bad "root refused" || ok "root refused"
$A enable --kiosk kiosk >/dev/null 2>&1 && bad "kiosk needs a managed device" || ok "kiosk needs a managed device"
$A enable --personal nimali >/dev/null && ok "personal device: enabled" || bad "personal device: enabled"
grep -A2 '^\[initial_session\]' "$T/config.toml" | grep -q 'user = "nimali"' && ok "initial_session written" || bad "initial_session written"
grep -q '^\[default_session\]' "$T/config.toml" && ok "greeter session kept" || bad "greeter session kept"
[ "$($A status)" = "enabled: nimali" ] && ok "status: enabled" || bad "status: enabled"
$A disable >/dev/null
grep -q initial_session "$T/config.toml" && bad "disable removes it" || ok "disable removes it"

echo '{"enrolled":true,"policy":{"version":"3","signature":"x","kiosk_autologin_user":"kiosk"}}' > "$T/state.json"
$A enable --personal nimali >/dev/null 2>&1 && bad "managed device: personal refused" || ok "managed device: personal refused"
$A enable --kiosk nimali >/dev/null 2>&1 && bad "kiosk: only the policy's account" || ok "kiosk: only the policy's account"
$A enable --kiosk kiosk >/dev/null && ok "kiosk: policy account enabled" || bad "kiosk: policy account enabled"
[ "$(grep -c '^\[initial_session\]' "$T/config.toml")" = 1 ] && ok "one initial_session" || bad "one initial_session"
echo "1..$n"
exit $fail
