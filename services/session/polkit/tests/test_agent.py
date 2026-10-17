"""The agent's side of the worksuite-polkit-listener pipe (agent.py): what it tells the listener and the shell for each
listener message. polkit itself runs in the C listener; tests/session/polkit-agent-integration.sh runs both against a
real polkitd and pkexec."""
import os
import pwd
import sys
import types
import unittest


class FakeGLib:
    IO_IN = IO_HUP = IO_ERR = 1

    @staticmethod
    def source_remove(_i):
        pass

    @staticmethod
    def timeout_add_seconds(_s, _fn):
        return 7

    class MainLoop:
        def run(self):
            pass

        def quit(self):
            pass


def install_fakes():
    gi = types.ModuleType("gi")
    repo = types.ModuleType("gi.repository")
    repo.GLib = FakeGLib
    gi.repository = repo
    sys.modules["gi"], sys.modules["gi.repository"] = gi, repo


install_fakes()
from worksuite_polkit_agent import agent, proto  # noqa: E402

ME = os.getuid()
MY_NAME = pwd.getpwuid(ME).pw_name


class Rec:
    def __init__(self, ok=True):
        self.sent, self.ok = [], ok

    def send(self, *m):
        self.sent.append(m[0] if len(m) == 1 else tuple(str(x) for x in m))
        return self.ok


def make(shell_ok=True):
    a = agent.Agent(None, shell=False)
    a.shell, a.helper = Rec(shell_ok), Rec()
    a.lockout = proto.Lockout(5, 600)
    return a


def feed(a, line):
    a.from_helper(proto.split_fields(line))


class AgentTest(unittest.TestCase):
    def begin(self, a, uids=None):
        feed(a, "detail\t1\tpolkit.subject-pid\t1")
        feed(a, f"begin\t1\torg.example.act\tNeeds you\t\t{uids or ME}")
        return a.shell.sent[-1]

    def test_begin_starts_pam_for_the_person_at_the_desk_and_shows_the_prompt(self):
        a = make()
        req = self.begin(a)
        self.assertEqual(req["type"], "request")
        self.assertEqual((req["action_id"], req["message"], req["user"]), ("org.example.act", "Needs you", MY_NAME))
        self.assertEqual(a.helper.sent, [("start", "1", str(ME))])

    def test_right_password_returns_ok_once(self):
        a = make()
        rid = self.begin(a)["id"]
        a.from_shell({"type": "respond", "id": rid, "password": "pw\twith tab"})
        feed(a, "request\t1\tPassword: \t0")
        self.assertEqual(a.helper.sent[-1], ("respond", "1", "pw\twith tab"))
        feed(a, "completed\t1\t1")
        self.assertEqual(a.helper.sent[-1], ("finish", "1", "ok"))
        self.assertEqual([m["type"] for m in a.shell.sent[1:]], ["result", "done"])
        feed(a, "completed\t1\t1")  # nothing more after the request ended
        self.assertEqual(sum(1 for m in a.helper.sent if m[0] == "finish"), 1)
        self.assertEqual(a.requests, {})

    def test_password_answers_a_pam_prompt_that_came_first(self):
        a = make()
        rid = self.begin(a)["id"]
        feed(a, "request\t1\tPassword: \t0")
        a.from_shell({"type": "respond", "id": rid, "password": "pw"})
        self.assertEqual(a.helper.sent[-1], ("respond", "1", "pw"))

    def test_wrong_password_restarts_pam_and_counts_down(self):
        a = make()
        rid = self.begin(a)["id"]
        feed(a, "request\t1\tPassword: \t0")
        a.from_shell({"type": "respond", "id": rid, "password": "bad"})
        feed(a, "completed\t1\t0")
        self.assertEqual(a.shell.sent[-1]["remaining"], 4)
        self.assertEqual(a.helper.sent[-1], ("start", "1", str(ME)))
        self.assertNotIn("finish", [m[0] for m in a.helper.sent])

    def test_cancel_from_the_shell(self):
        a = make()
        rid = self.begin(a)["id"]
        a.from_shell({"type": "cancel", "id": rid})
        self.assertEqual(a.helper.sent[-1], ("finish", "1", "cancel"))
        self.assertEqual(a.shell.sent[-1], {"type": "done", "id": rid})

    def test_polkit_withdraws_the_request(self):
        a = make()
        rid = self.begin(a)["id"]
        feed(a, "cancelled\t1")
        self.assertNotIn("finish", [m[0] for m in a.helper.sent])  # the listener already returned it
        self.assertEqual(a.shell.sent[-1], {"type": "done", "id": rid})

    def test_no_known_identity_fails_the_request(self):
        a = make()
        feed(a, "begin\t1\torg.example.act\tNeeds you\t\t")
        self.assertEqual(a.helper.sent, [("finish", "1", "fail")])

    def test_waits_for_the_shell(self):
        a = make(shell_ok=False)
        self.begin(a)
        r = next(iter(a.requests.values()))
        self.assertEqual(r.timer, 7)


class FieldsTest(unittest.TestCase):
    def test_round_trip(self):
        for f in ["plain", "tab\there", "new\nline", "back\\slash\\t", ""]:
            self.assertEqual(proto.split_fields(proto.join_fields(["x", f]))[1], f)


if __name__ == "__main__":
    unittest.main()
