#!/bin/sh
# WorkSuite's polkit agent against a real polkitd and pkexec (WSOS-INT-010). Run as root; needs polkitd, pkexec, a C
# compiler and libpolkit-agent-1-dev. Starts a system bus and polkitd when none are running (a chroot), adds a
# throwaway administrator (group sudo) and runs `pkexec true` with a stand-in shell answering on the agent's socket:
# right password, wrong then right, cancel, wrong then cancel. The listener registers for the pkexec caller's process
# (--process), so no logind session is needed. It used to SIGSEGV in libpolkit-agent-1 at the end of every request.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
[ "$(id -u)" = 0 ] || { echo "SKIP: run as root"; exit 0; }
for c in pkexec cc pkg-config python3; do command -v $c >/dev/null || { echo "SKIP: no $c"; exit 0; }; done
PKD=$(ls /usr/lib/polkit-1/polkitd /usr/libexec/polkitd 2>/dev/null | head -1)
[ -n "$PKD" ] && pkg-config --exists polkit-agent-1 || { echo "SKIP: polkitd or libpolkit-agent-1-dev missing"; exit 0; }

T=$(mktemp -d /tmp/ws-pk-XXXXXX); chmod 755 "$T"
U=wspktest$$; PW=Ws-pk-$$-ok
STARTED=""
cleanup() {
    for p in $STARTED; do kill "$p" 2>/dev/null; done
    pkill -u "$U" 2>/dev/null; sleep 0.3; userdel -r "$U" >/dev/null 2>&1; rm -rf "$T"
}
trap cleanup EXIT INT TERM

make -s -C "$ROOT/services/session/polkit/listener" OUT="$T" >/dev/null || { echo "FAIL: listener does not build"; exit 1; }
if [ ! -S /run/dbus/system_bus_socket ]; then
    mkdir -p /run/dbus; rm -f /run/dbus/pid; dbus-daemon --system --fork --print-pid > "$T/dbus.pid" && STARTED="$(cat "$T/dbus.pid")"
fi
if ! busctl --system status org.freedesktop.PolicyKit1 >/dev/null 2>&1; then
    "$PKD" --no-debug >"$T/polkitd.log" 2>&1 & STARTED="$STARTED $!"
    sleep 1
fi
useradd -m -G sudo "$U" && echo "$U:$PW" | chpasswd || { echo "FAIL: useradd"; exit 1; }
cp -r "$ROOT/services/session/polkit/worksuite_polkit_agent" "$T/"
cat > "$T/shell.py" <<'PY'
import json, os, socket, sys, time
for _ in range(100):
    try:
        s = socket.socket(socket.AF_UNIX); s.connect(os.environ["XDG_RUNTIME_DIR"] + "/worksuite-polkit.sock"); break
    except OSError:
        time.sleep(0.1)
f = s.makefile("rwb"); answers = sys.argv[1].split(",")
for line in f:
    m = json.loads(line)
    print(m["type"], m.get("ok", ""), flush=True)
    if m["type"] == "done":
        break
    if (m["type"] == "request" or (m["type"] == "result" and not m["ok"])) and answers:
        a = answers.pop(0)
        out = {"type": "cancel", "id": m["id"]} if a == "cancel" else {"type": "respond", "id": m["id"], "password": a}
        f.write((json.dumps(out) + "\n").encode()); f.flush()
PY
chown -R "$U" "$T"

fail=0
run() {  # answers expected-pkexec-exit
    rm -rf "$T/rt"; install -d -m 700 -o "$U" "$T/rt"
    runuser -u "$U" -- env XDG_RUNTIME_DIR="$T/rt" PYTHONPATH="$T" WORKSUITE_POLKIT_LISTENER="$T/worksuite-polkit-listener" sh -c '
        sh -c "echo \$\$ > $XDG_RUNTIME_DIR/caller; sleep 2; pkexec true; r=\$?; exit \$r" & C=$!
        sleep 0.5
        python3 -m worksuite_polkit_agent --process $(cat $XDG_RUNTIME_DIR/caller) 2>$XDG_RUNTIME_DIR/agent.log & A=$!
        timeout 30 python3 '"$T"'/shell.py "$1" > $XDG_RUNTIME_DIR/shell.log
        wait $C; echo $? > $XDG_RUNTIME_DIR/rc
        sleep 0.5; kill -0 $A 2>/dev/null && echo alive > $XDG_RUNTIME_DIR/alive; kill $A 2>/dev/null; wait $A
        echo $? > $XDG_RUNTIME_DIR/agent-rc' sh "$1"
    rc=$(cat "$T/rt/rc" 2>/dev/null); arc=$(cat "$T/rt/agent-rc" 2>/dev/null)
    name=$(echo "$1" | sed "s/$PW/right/g")
    if [ "$rc" = "$2" ] && [ -f "$T/rt/alive" ] && ! grep -qi 'segmentation\|traceback' "$T/rt/agent.log"; then
        echo "ok - $name: pkexec exit $rc, agent still running"
    else
        echo "FAIL - $name: pkexec exit $rc (want $2), agent exit $arc"; sed 's/^/    /' "$T/rt/shell.log" "$T/rt/agent.log"; fail=1
    fi
}
run "$PW" 0
run "wrong,$PW" 0
run cancel 126
run "wrong,cancel" 126
exit $fail
