#!/bin/bash
# Runs inside debian:trixie. Every step prints its own result; the summary at the end checks the real system.
set -u
step() { echo; echo "======== $* ========"; }
D='node --no-warnings /e2e/drive.ts'

step "0. clean Debian 13 + signed HTTPS sources"
sed -i 's#http://#https://#g' /etc/apt/sources.list.d/debian.sources
echo 'Acquire::https::CaInfo "/ca.crt";' > /etc/apt/apt.conf.d/99ca
grep -c . /etc/apt/sources.list.d/debian.sources; dpkg -l | grep -c '^ii'
echo '{"setup_restricted_apps":["worksuite-desk"],"software_install":"approved","app_allowlist":["apt:hello"]}' > /policy.json
cat /policy.json

step "1. OFFLINE setup: Desktop+Office+POS+FrameFlow from verified bundled debs; Desk restricted; VLC not allowed"
apt-get -q update >/dev/null 2>&1   # dependency lists only (an image carries the dependencies; this container does not)
$D setup worksuite-office,worksuite-pos,worksuite-desk,worksuite-frameflow,vlc --offline

step "2. same setup again (idempotent): everything already installed"
$D setup worksuite-office,worksuite-pos,worksuite-frameflow --offline

step "3. OFFLINE third-party app on the allowlist: queued (no bundled copy)"
cat > /policy.json <<'EOF'
{"software_install":"approved","app_allowlist":["apt:vlc"]}
EOF
$D setup vlc --offline

step "4. back online: drain the queue (signed APT)"
$D drain

step "5. tampered bundled package: refused, never handed to apt"
apt-get -y -q remove worksuite-pos >/dev/null 2>&1; echo "before: $(dpkg-query -W -f='${Status}' worksuite-pos)"
mkdir -p /tampered && cp -l /bundled/*.deb /tampered/ 2>/dev/null || cp /bundled/worksuite-pos_1.0.8_amd64.deb /tampered/
sed 's/^\(.\)/0/' /bundled/SHA256SUMS > /tampered/SHA256SUMS   # first hex digit of every sum changed
echo '{}' > /policy.json
$D setup worksuite-pos --offline --bundled /tampered
dpkg-query -W -f='${Status}' worksuite-pos | grep -q "install ok installed" && echo "FAIL: tampered pos got installed" || echo "ok: tampered pos not installed ($(dpkg-query -W -f='${Status}' worksuite-pos))"

step "6. unresolvable package: one attempt, clear reason, setup not failed (optional app)"
$D unresolvable

step "7. the real system afterwards"
for p in worksuite worksuite-office worksuite-pos worksuite-desk worksuite-frameflow vlc; do printf '%-22s %s\n' "$p" "$(dpkg-query -W -f='${Status} ${Version}' $p 2>/dev/null || echo 'not installed')"; done
for b in /opt/WorkSuite/worksuite "/opt/WorkSuite POS/worksuite-pos" "/opt/Worksuite FrameFlow/worksuite-frameflow" /usr/bin/vlc; do
  [ -e "$b" ] && printf '%-48s missing libs: %s\n' "$b" "$(ldd "$b" 2>/dev/null | grep -c 'not found')" || echo "$b: absent"
done
ls /usr/share/applications | grep -E 'worksuite|vlc' | tr '\n' ' '; echo
grep -h '^Exec=' /usr/share/applications/worksuite*.desktop | head -5
