#!/bin/sh
# WSOS-LCH-002: X11 apps run through XWayland started on demand by Labwc, with WorkSuite's own rc.xml and
# environment. Headless Labwc (pixman), no GPU, no root. Needs: labwc, Xwayland (xwayland), xdpyinfo (x11-utils).
# Run: sh tests/session/xwayland-test.sh
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
for p in labwc Xwayland xdpyinfo pgrep; do command -v $p >/dev/null || { echo "1..0 # SKIP $p not installed"; exit 0; }; done
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/run" "$T/cfg/labwc"; chmod 700 "$T/run"
cp "$ROOT/services/session/labwc/rc.xml" "$ROOT/services/session/labwc/environment" "$T/cfg/labwc/"
fail=0; n=0
ok()  { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=1; echo "not ok $n - $1"; }

# The startup command plays an X11 client: it records DISPLAY, whether Xwayland ran before any X client
# connected, then connects with xdpyinfo, and exits Labwc.
cat > "$T/client.sh" <<EOS
#!/bin/sh
echo "\$DISPLAY" > "$T/display"
sleep 1
pgrep -u "\$(id -u)" -x Xwayland > "$T/before" || true
xdpyinfo > "$T/xdpyinfo" 2>&1; echo \$? > "$T/rc"
labwc --exit
EOS
chmod +x "$T/client.sh"
XDG_RUNTIME_DIR="$T/run" XDG_CONFIG_HOME="$T/cfg" WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
  timeout 60 labwc -C "$T/cfg/labwc" -s "$T/client.sh" > "$T/labwc.log" 2>&1

d=$(cat "$T/display" 2>/dev/null)
case "$d" in :[0-9]*) ok "Labwc exports an X11 DISPLAY ($d) to the session" ;; *) bad "no DISPLAY in the session (got '$d')"; tail -20 "$T/labwc.log" | sed 's/^/#   /' ;; esac
if [ ! -s "$T/before" ]; then ok "XWayland is not running before an X11 client connects (on demand)"; else bad "XWayland started eagerly"; fi
if [ "$(cat "$T/rc" 2>/dev/null)" = 0 ] && grep -q 'vendor string:.*X.Org' "$T/xdpyinfo"; then ok "an X11 client connects through XWayland"; else bad "X11 client could not connect"; sed 's/^/#   /' "$T/xdpyinfo" 2>/dev/null | head; fi

# Packaging: XWayland is a hard dependency (the image is built without Recommends).
if grep -A3 '^Package: worksuite-session' "$ROOT/packaging/debian/control" | grep -q 'xwayland'; then ok "worksuite-session depends on xwayland"; else bad "worksuite-session does not depend on xwayland"; fi
if grep -q 'DISPLAY' "$ROOT/services/session/bin/worksuite-session"; then ok "worksuite-session imports DISPLAY into the user manager"; else bad "DISPLAY not imported"; fi

echo "1..$n"
exit $fail
