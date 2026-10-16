"""Calamares configuration checks: what the installer asks (WSOS-INS-002), that it needs no network (WSOS-INS-005)
and that the installed system gets a fresh identity with no live-session credentials (WSOS-INS-007)."""
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent
MODULES = ROOT / "modules"


def load(path: Path):
    return yaml.safe_load(path.read_text())


def sequence():
    settings = load(ROOT / "settings.conf")
    shows, execs = [], []
    for step in settings["sequence"]:
        (shows if "show" in step else execs).extend(step.get("show") or step.get("exec"))
    return settings, shows, execs


class InstallerAsksTest(unittest.TestCase):
    """WSOS-INS-002: language, keyboard, timezone and the first administrator."""

    def test_pages_and_jobs(self):
        _, shows, execs = sequence()
        for page in ("welcomeq", "keyboardq", "localeq", "usersq"):
            self.assertIn(page, shows)
        # the matching jobs write the choices into the target
        for job in ("localecfg", "keyboardq", "localeq", "usersq"):
            self.assertIn(job, execs)
        self.assertLess(shows.index("welcomeq"), shows.index("usersq"))
        self.assertLess(shows.index("usersq"), shows.index("summaryq"))

    def test_first_account_is_an_administrator(self):
        users = load(MODULES / "usersq.conf")
        self.assertEqual(users["sudoersGroup"], "sudo")
        groups = [g["name"] if isinstance(g, dict) else g for g in users["defaultGroups"]]
        self.assertIn("sudo", groups)
        self.assertFalse(users["setRootPassword"], "root stays locked; the first user administers through sudo/polkit")
        self.assertFalse(users["doAutologin"])
        self.assertGreaterEqual(users["passwordRequirements"]["minLength"], 8)
        self.assertFalse(users["allowWeakPasswords"])

    def test_timezone_has_a_default(self):
        locale = load(MODULES / "localeq.conf")
        self.assertTrue(locale["region"] and locale["zone"])


class OfflineInstallTest(unittest.TestCase):
    """WSOS-INS-005: nothing in the install path needs the network."""

    def test_welcome_does_not_require_internet(self):
        req = load(MODULES / "welcomeq.conf")["requirements"]
        self.assertNotIn("internet", req["required"])

    def test_packages_only_removes_live_tools(self):
        pk = load(MODULES / "packages.conf")
        self.assertFalse(pk["update_db"])
        self.assertFalse(pk["skip_if_no_internet"])
        for op in pk["operations"]:
            self.assertEqual(set(op), {"remove"}, "no install/try_install: packages would come from the network")

    def test_system_comes_from_the_iso(self):
        unpack = load(MODULES / "unpackfs.conf")["unpack"]
        self.assertTrue(all(u["source"].startswith("/run/live/medium/") for u in unpack))

    def test_no_job_downloads_anything(self):
        _, _, execs = sequence()
        self.assertNotIn("networkcfg", execs)
        for conf in MODULES.glob("*.conf"):
            text = conf.read_text()
            self.assertNotRegex(text, r"\b(apt-get|apt) (install|update)|\bcurl\b|\bwget\b|https?://(?!www\.gnu)", conf.name)

    def test_bootloader_packages_are_in_the_image(self):
        lst = (REPO / "live-build/config/package-lists/worksuite.list.chroot").read_text()
        for pkg in ("grub-efi-amd64-signed", "grub-efi-arm64-signed", "shim-signed", "efibootmgr", "squashfs-tools", "rsync",
                    "cryptsetup-initramfs", "dosfstools"):
            self.assertRegex(lst, rf"(?m)^{re.escape(pkg)}$")


class FreshIdentityTest(unittest.TestCase):
    """WSOS-INS-007: fresh machine-id, no live-user credentials or enrollment identity."""

    def test_machine_id_is_generated_on_the_target(self):
        mid = load(MODULES / "machineid.conf")
        self.assertTrue(mid["systemd"])
        self.assertEqual(mid["systemd-style"], "uuid")
        self.assertFalse(mid["entropy-copy"])
        _, _, execs = sequence()
        self.assertLess(execs.index("unpackfs"), execs.index("machineid"))

    def test_image_has_no_machine_id(self):
        hook = (REPO / "live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot").read_text()
        self.assertIn(": > /etc/machine-id", hook)
        self.assertIn("rm -f /var/lib/dbus/machine-id", hook)

    def test_live_session_state_is_not_copied(self):
        _, _, execs = sequence()
        # networkcfg copies the live session's NetworkManager connections (Wi-Fi passphrases) into the target
        self.assertNotIn("networkcfg", execs)
        # the system is unpacked from the read-only squashfs, not the running live overlay with the live user
        self.assertEqual([u["source"] for u in load(MODULES / "unpackfs.conf")["unpack"]], ["/run/live/medium/live/filesystem.squashfs"])
        users = load(MODULES / "usersq.conf")
        self.assertFalse(users["doReusePassword"])

    def test_post_install_clears_identities(self):
        sp = load(MODULES / "shellprocess-worksuite.conf")
        script = " ; ".join(sp["script"])
        self.assertFalse(sp["dontChroot"])
        for path in ("/var/lib/worksuite-device-agent/*", "/etc/worksuite/enrollment*", "/etc/ssh/ssh_host_*",
                     "/etc/NetworkManager/system-connections/*"):
            self.assertIn(path, script)
        _, _, execs = sequence()
        self.assertLess(execs.index("unpackfs"), execs.index("shellprocess@worksuite"))

    def test_live_tools_are_removed(self):
        removed = load(MODULES / "packages.conf")["operations"][0]["remove"]
        for pkg in ("live-boot", "live-config", "user-setup", "calamares"):
            self.assertIn(pkg, removed)


if __name__ == "__main__":
    unittest.main()



class BootSplashTest(unittest.TestCase):
    """The WorkSuite Plymouth theme reaches both the live and the installed initramfs."""

    def test_splash_on_both_command_lines(self):
        live = (REPO / "live-build/auto/config").read_text()
        self.assertRegex(live, r"bootappend-live \"[^\"]*\bsplash\b[^\"]*plymouth\.ignore-serial-consoles")
        grub = (REPO / "branding/grub/worksuite.cfg").read_text()
        self.assertIn('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash ', grub)
        for quiet in ("loglevel=3", "systemd.show_status=false", "rd.udev.log_level=3", "vt.global_cursor_default=0"):
            self.assertIn(quiet, grub)
        self.assertIn("GRUB_TIMEOUT_STYLE=hidden", grub)
        self.assertIn("GRUB_TIMEOUT=1", grub)   # hidden, but Esc/F4/Shift open the menu
        self.assertIn("GRUB_ENABLE_CRYPTODISK=n", grub)
        self.assertIn("GRUB_TERMINAL_OUTPUT=gfxterm", grub)
        self.assertIn("GRUB_GFXPAYLOAD_LINUX=keep", grub)
        self.assertEqual(load(MODULES / "grubcfg.conf")["kernel_params"], ["quiet"])

    def test_initramfs_has_framebuffer_and_theme(self):
        self.assertIn("FRAMEBUFFER=y", (REPO / "branding/initramfs/worksuite-splash.conf").read_text())
        self.assertIn("etc/initramfs-tools/conf.d/worksuite-splash", (REPO / "packaging/debian/rules").read_text())
        self.assertIn("plymouth-set-default-theme -R worksuite", (REPO / "packaging/debian/worksuite-branding.postinst").read_text())
        script = " ".join(load(MODULES / "shellprocess-worksuite.conf")["script"])
        self.assertIn("plymouth-set-default-theme worksuite", script)
        _, _, execs = sequence()
        self.assertLess(execs.index("shellprocess@worksuite"), execs.index("initramfs"))

    def test_initramfs_hook_packages(self):
        pkgs = (REPO / "live-build/config/package-lists/worksuite.list.chroot").read_text().split()
        for p in ("console-setup", "zstd", "plymouth", "worksuite-branding"):
            self.assertIn(p, pkgs)


class EnrollmentTest(unittest.TestCase):
    """WSOS-INS-006: optional enrollment page after the account page, applied by the device agent on first boot."""

    def test_page_and_job_order(self):
        settings, shows, execs = sequence()
        self.assertEqual(shows[shows.index("usersq") + 1], "worksuiteconfirm@enroll")
        self.assertIn({"id": "enroll", "module": "worksuiteconfirm", "config": "worksuiteconfirm-enroll.conf"}, settings["instances"])
        self.assertEqual(load(MODULES / "worksuiteconfirm-enroll.conf")["mode"], "enroll")
        self.assertGreater(execs.index("worksuiteenroll"), execs.index("usersq"))
        self.assertLess(execs.index("worksuiteenroll"), execs.index("umount"))


class StepIndexTest(unittest.TestCase):
    """The sidebar and footer map Calamares step indices; a page added to the sequence must not shift them."""

    def steps(self):
        seq = load(ROOT / "settings.conf")["sequence"]
        n = 0
        for block in seq:
            n += len(block["show"]) if "show" in block else 1   # the exec block is one step
        return n

    def test_sidebar_maps_every_step(self):
        qml = (ROOT / "branding" / "worksuite" / "calamares-sidebar.qml").read_text()
        m = re.search(r"readonly property var stepOf: (\[.*\])\n", qml)
        self.assertEqual(len(re.findall(r"\[\d+, \d+\]", m.group(1))), self.steps())

    def test_footer_counts_from_the_end_and_hides_back_after_install(self):
        qml = (ROOT / "branding" / "worksuite" / "calamares-navigation.qml").read_text()
        last = int(re.search(r"readonly property int lastStep: (\d+)", qml).group(1))
        self.assertEqual(last, self.steps() - 1)
        self.assertNotRegex(qml, r"currentStepIndex >= \d")
        self.assertIn("visible: ViewManager.backAndNextVisible && !nav.afterInstall", qml)


class CopyPageTest(unittest.TestCase):
    def test_numbers_are_real(self):
        qml = (ROOT / "branding" / "worksuite" / "show.qml").read_text()
        self.assertNotIn("under a minute", qml)
        self.assertIn("bytesDone / bytesTotal", qml)          # percentage agrees with the GB shown
        self.assertIn('num("worksuiteImagePackages")', qml)
        hook = (ROOT.parent / "live-build" / "config" / "hooks" / "normal" / "9900-worksuite-rootfs-size.hook.chroot").read_text()
        self.assertIn("/usr/share/worksuite/rootfs.files", hook)
        self.assertIn("/usr/share/worksuite/rootfs.packages", hook)
        cpp = (ROOT / "modules" / "worksuiteconfirm" / "WorksuiteConfirmViewStep.cpp").read_text()
        self.assertIn("worksuiteImagePackages", cpp)
        self.assertIn("f_files - vfs.f_ffree", cpp)


class PageIndexTest(unittest.TestCase):
    def test_qml_pages_know_their_step_index(self):
        # WsPage uses stepIndex to know it is the current page (and to skip itself in Express); a wrong one made the
        # enroll page skip itself (localeq said 4 after the enroll page was added at 4).
        seq = load(ROOT / "settings.conf")["sequence"]
        shown = []
        for block in seq:
            shown += block["show"] if "show" in block else ["<exec>"]
        for qml in (ROOT / "branding" / "worksuite").glob("*q.qml"):
            m = re.search(r"^\s*stepIndex: (\d+)", qml.read_text(), re.M)
            if m:
                self.assertEqual(shown.index(qml.stem), int(m.group(1)), qml.name)


class BootPartitionTest(unittest.TestCase):
    def test_boot_is_unencrypted_root_in_luks2(self):
        conf = load(ROOT / "modules" / "partition.conf")
        self.assertEqual(conf["luksGeneration"], "luks2")
        layout = {p["mountPoint"]: p for p in conf["partitionLayout"]}
        self.assertTrue(layout["/boot"]["noEncrypt"])
        self.assertEqual(layout["/boot"]["filesystem"], "ext4")
        self.assertFalse(layout["/"].get("noEncrypt", False))
        hook = (ROOT.parent / "live-build/config/hooks/normal/0100-worksuite-defaults.hook.chroot").read_text()
        self.assertIn("/etc/grub.d/10_linux", hook)
