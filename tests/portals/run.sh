#!/bin/sh
# Portal acceptance (SRS §7.1): real xdg-desktop-portal + -wlr + -gtk against a headless Labwc, on a private session
# bus with PipeWire, using WorkSuite's own portals.conf, xdpw config and consent chooser (zenity stubbed: the stub
# "picks" the output named in $T/consent, or denies when it is empty).
#   tests/portals/run.sh          needs: labwc xdg-desktop-portal xdg-desktop-portal-wlr xdg-desktop-portal-gtk
#                                        pipewire wireplumber dbus-daemon python3-dbus-next
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
if [ -z "${PORTAL_TEST_INNER:-}" ]; then
    exec env PORTAL_TEST_INNER=1 dbus-run-session -- sh "$0" "$@"
fi
T=$(mktemp -d)
export XDG_RUNTIME_DIR="$T/run" HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/home/.local/share"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME/xdg-desktop-portal" "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr" \
    "$XDG_DATA_HOME/applications" "$T/bin" "$HOME/Pictures"
chmod 700 "$XDG_RUNTIME_DIR"
pids=''
cleanup() {
    for p in $pids; do kill "$p" 2>/dev/null || true; done
    fusermount -u "$T/run/doc" 2>/dev/null || fusermount3 -u "$T/run/doc" 2>/dev/null || true
    rm -rf "$T" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# WorkSuite portal configuration, exactly as installed (only the chooser path is pointed at the source tree).
cp "$ROOT/services/session/portals/worksuite-portals.conf" "$XDG_CONFIG_HOME/xdg-desktop-portal/worksuite-portals.conf"
sed "s#^chooser_cmd=.*#chooser_cmd=$ROOT/services/session/bin/worksuite-screencast-chooser#" \
    "$ROOT/services/session/xdg-desktop-portal-wlr/config" > "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr/config"
printf '#!/bin/sh\necho "$*" >> "%s/chooser.log"\nc=$(cat "%s/consent" 2>/dev/null)\n[ -n "$c" ] || exit 1\necho "$c"\n' "$T" "$T" > "$T/bin/zenity"
chmod +x "$T/bin/zenity"
export PATH="$T/bin:$PATH"

# OpenURI target: the default handler for x-worksuite-test: records the URI it was given.
cat > "$XDG_DATA_HOME/applications/ws-uri-test.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=WorkSuite URI test
Exec=sh -c 'printf "%%s\\\\n" "\$1" > "$T/opened-uri"' sh %u
MimeType=x-scheme-handler/x-worksuite-test;
NoDisplay=true
EOF
printf '[Default Applications]\nx-scheme-handler/x-worksuite-test=ws-uri-test.desktop\n' > "$XDG_CONFIG_HOME/mimeapps.list"
printf "[MIME Cache]\nx-scheme-handler/x-worksuite-test=ws-uri-test.desktop;\n" > "$XDG_DATA_HOME/applications/mimeinfo.cache"

# PipeWire (ScreenCast streams) and the compositor.
pipewire >"$T/pipewire.log" 2>&1 & pids="$pids $!"
sleep 1
wireplumber >"$T/wireplumber.log" 2>&1 & pids="$pids $!"
# xdg-desktop-portal-wlr 0.7 starts a ScreenCast stream only with DMA-BUF screencopy, i.e. a GPU render node; without
# one Labwc runs the pixman renderer and the stream test reports a skip (consent, denial and stop are still tested).
if ls /dev/dri/renderD* >/dev/null 2>&1; then export WLR_RENDERER=${WLR_RENDERER:-gles2}; else export PORTAL_NO_DMABUF=1; fi
export XDG_CURRENT_DESKTOP=WorkSuite:wlroots XDG_SESSION_TYPE=wayland WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=${WLR_RENDERER:-pixman}
mkdir -p "$XDG_CONFIG_HOME/labwc"; echo "<labwc_config/>" > "$XDG_CONFIG_HOME/labwc/rc.xml"
labwc >"$T/labwc.log" 2>&1 & pids="$pids $!"
# shellcheck disable=SC2010 # socket names are wayland-N
i=0; while [ -z "$(ls "$XDG_RUNTIME_DIR" | grep '^wayland-[0-9]*$' | head -1)" ]; do i=$((i + 1)); [ $i -lt 100 ] || { cat "$T/labwc.log"; exit 1; }; sleep 0.1; done
WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep '^wayland-[0-9]*$' | head -1); export WAYLAND_DISPLAY
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME HOME PATH LANG 2>/dev/null \
    || dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_CONFIG_HOME XDG_DATA_HOME PATH

python3 "$ROOT/tests/portals/notify_stub.py" "$T/notifications.log" & pids="$pids $!"

# Start the portal stack explicitly so a backend that fails to start shows up here, not as a test timeout.
for b in /usr/libexec/xdg-desktop-portal-wlr /usr/libexec/xdg-desktop-portal-gtk; do
    [ -x "$b" ] || b=/usr/lib/${b##*/}
    if [ "${b##*/}" = xdg-desktop-portal-wlr ]; then "$b" -l DEBUG >"$T/${b##*/}.log" 2>&1 & pids="$pids $!"; else "$b" >"$T/${b##*/}.log" 2>&1 & pids="$pids $!"; fi
done
sleep 1
d=/usr/libexec/xdg-desktop-portal; [ -x "$d" ] || d=/usr/lib/xdg-desktop-portal
"$d" -v >"$T/xdg-desktop-portal.log" 2>&1 & pids="$pids $!"
i=0; until gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -lt 100 ] || { cat "$T/xdg-desktop-portal.log"; exit 1; }; sleep 0.1
done

rc=0
PORTAL_TEST_DIR=$T python3 "$ROOT/tests/portals/portal_acceptance.py" "$@" || rc=$?
if [ "$rc" != 0 ]; then
    for f in xdg-desktop-portal xdg-desktop-portal-wlr xdg-desktop-portal-gtk labwc pipewire wireplumber; do echo "--- $f.log"; tail -40 "$T/$f.log"; done
fi
exit "$rc"
