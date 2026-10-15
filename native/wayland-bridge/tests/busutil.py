"""Private session bus for tests."""
import os
import shutil
import subprocess
import tempfile


class PrivateBus:
    def __enter__(self):
        if not shutil.which("dbus-daemon"):
            raise RuntimeError("dbus-daemon not installed")
        self.dir = tempfile.mkdtemp()
        conf = os.path.join(self.dir, "bus.conf")
        with open(conf, "w") as f:
            f.write(f"""<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path={self.dir}/bus</listen>
<auth>EXTERNAL</auth><policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>""")
        self.proc = subprocess.Popen(["dbus-daemon", "--config-file", conf, "--nofork", "--print-address"], stdout=subprocess.PIPE, text=True)
        self.address = self.proc.stdout.readline().strip()
        return self

    def __exit__(self, *exc):
        self.proc.terminate()
        self.proc.wait()
        self.proc.stdout.close()
        shutil.rmtree(self.dir, ignore_errors=True)
