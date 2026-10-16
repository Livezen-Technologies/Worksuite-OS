#!/bin/sh
# Smart-card sign-in wiring (WSOS-DIR-011): off by default, refuses to enable without a trusted CA, then installs the
# pam_pkcs11 config and enables the pam-auth-update profile. No card reader is involved.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
S=$ROOT/services/directory/smartcard
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
n=0; fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }

grep -q '^Default: no$' "$S/worksuite-smartcard" && ok "profile is off by default" || bad "profile is off by default"
grep -q 'pam_pkcs11.so' "$S/worksuite-smartcard" && ok "profile uses pam_pkcs11" || bad "profile uses pam_pkcs11"
grep -q 'cert_policy = ca,signature,crl_auto;' "$S/pam_pkcs11.conf" && ok "certificates are CA- and CRL-checked" || bad "certificate policy"
grep -q 'nullok = false;' "$S/pam_pkcs11.conf" && ok "no empty PIN" || bad "no empty PIN"

mkdir -p "$T/pkcs11/cacerts"
printf '#!/bin/sh\necho "pam-auth-update $*" >> "%s/log"\n' "$T" > "$T/pau"; chmod +x "$T/pau"
export WORKSUITE_PKCS11_DIR="$T/pkcs11" WORKSUITE_SMARTCARD_SHARE="$S" WORKSUITE_PAM_AUTH_UPDATE="$T/pau" WORKSUITE_COMMON_AUTH="$T/common-auth"
sh "$S/worksuite-smartcard-setup" enable >/dev/null 2>&1 && bad "enable without a CA is refused" || ok "enable without a CA is refused"
[ -e "$T/log" ] && bad "nothing enabled without a CA" || ok "nothing enabled without a CA"
: > "$T/pkcs11/cacerts/corp-root.pem"
sh "$S/worksuite-smartcard-setup" enable >/dev/null && ok "enable with a CA" || bad "enable with a CA"
grep -q 'pam-auth-update --enable worksuite-smartcard' "$T/log" && ok "profile enabled" || bad "profile enabled"
grep -q 'use_mappers = ms;' "$T/pkcs11/pam_pkcs11.conf" && ok "config installed (UPN mapper)" || bad "config installed"
echo "auth pam_pkcs11.so" > "$T/common-auth"
[ "$(sh "$S/worksuite-smartcard-setup" status)" = enabled ] && ok "status" || bad "status"
sh "$S/worksuite-smartcard-setup" disable >/dev/null
grep -q 'pam-auth-update --disable worksuite-smartcard' "$T/log" && ok "disable" || bad "disable"
echo "1..$n"
exit $fail
