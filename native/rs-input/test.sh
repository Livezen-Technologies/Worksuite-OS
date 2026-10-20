#!/bin/sh
# worksuite-rs-input against a headless labwc (issue #37): every command reaches the compositor as the right
# virtual-pointer / virtual-keyboard request (WAYLAND_DEBUG=server), with separate press and release, absolute
# motion and a keymap labwc accepts. Skips when labwc is not installed.
set -eu
cd "$(dirname "$0")"
make -s worksuite-rs-input
command -v labwc >/dev/null || { echo "SKIP: labwc not installed"; exit 0; }
t=$(mktemp -d); trap 'kill $pid 2>/dev/null || true; rm -rf "$t"' EXIT
mkdir -m 700 "$t/run"
XDG_RUNTIME_DIR="$t/run" WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WAYLAND_DEBUG=server \
  labwc -C "$t/none" >"$t/labwc.log" 2>&1 &
pid=$!
i=0; while [ ! -S "$t/run/wayland-0" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
out=$(printf 'm 10 20 100 100\nb 272 1\nm 50 50 100 100\nb 272 0\nb 999 1\na v -2\nk ffe1 1\nk 41 1\nk 41 0\nk ffe1 0\nk 1000df 1\nr\no NOPE-1\nq\n' \
  | XDG_RUNTIME_DIR="$t/run" WAYLAND_DISPLAY=wayland-0 ./worksuite-rs-input)
sleep 0.3
fail=0
check() { grep -q -- "$1" "$t/labwc.log" || { echo "FAIL: compositor did not get $1"; fail=1; }; }
[ "$(echo "$out" | head -1)" = ready ] || { echo "FAIL: helper said: $out"; fail=1; }
[ "$(echo "$out" | grep -c '^err bad_command')" = 2 ] || { echo "FAIL: bad commands not refused: $out"; fail=1; }
check 'motion_absolute([0-9]*, 10, 20, 100, 100)'
check 'button([0-9]*, 272, 1)'
check 'motion_absolute([0-9]*, 50, 50, 100, 100)'
check 'button([0-9]*, 272, 0)'
check 'axis_discrete([0-9]*, 0, -30.00000000, -2)'
check 'modifiers(1, 0, 0, 0)'
check 'zwp_virtual_keyboard_v1@[0-9]*.key([0-9]*, 1, 1)'
check 'zwp_virtual_keyboard_v1@[0-9]*.key([0-9]*, 1, 0)'
# "r" releases the still-held ß key (keycode 2).
check 'zwp_virtual_keyboard_v1@[0-9]*.key([0-9]*, 2, 0)'
if grep -qi 'protocol error\|error.*keymap' "$t/labwc.log"; then echo "FAIL: compositor error"; grep -i error "$t/labwc.log"; fail=1; fi
[ $fail = 0 ] && echo "rs-input: all checks passed"
exit $fail
