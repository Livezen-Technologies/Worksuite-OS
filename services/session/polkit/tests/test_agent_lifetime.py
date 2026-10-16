"""The agent keeps each PolkitAgent.Session referenced until its "completed" emission is over (freeing it inside the
handler segfaulted libpolkit-agent-1 after every password) and starts the retry session from GLib idle."""
import sys
import types
import unittest
import weakref


class FakeGLib:
    idle = []

    @classmethod
    def idle_add(cls, fn, *a):
        cls.idle.append((fn, a))
        return len(cls.idle)

    @staticmethod
    def source_remove(_i):
        pass

    @classmethod
    def run_idle(cls):
        while cls.idle:
            fn, a = cls.idle.pop(0)
            fn(*a)


class FakeSession:
    made = []

    def __init__(self):
        self.handlers, self.cancelled = {}, False
        FakeSession.made.append(weakref.ref(self))

    @classmethod
    def new(cls, _user, _cookie):
        return cls()

    def connect(self, name, fn):
        self.handlers[name] = fn

    def initiate(self):
        pass

    def response(self, _pw):
        pass

    def cancel(self):
        self.cancelled = True

    def emit_completed(self, gained):
        ref = weakref.ref(self)
        fn = self.handlers["completed"]
        del self  # only the emitter's own frame (and the agent) may hold it now
        fn(ref(), gained)
        return ref


def install_fakes():
    gi = types.ModuleType("gi")
    gi.require_version = lambda *_a: None
    repo = types.ModuleType("gi.repository")
    repo.GLib = FakeGLib
    repo.Gio = types.SimpleNamespace()
    repo.Polkit = types.SimpleNamespace(UnixUser=types.SimpleNamespace(new=lambda uid: uid))
    repo.PolkitAgent = types.SimpleNamespace(Session=FakeSession, Listener=object)
    gi.repository = repo
    sys.modules["gi"], sys.modules["gi.repository"] = gi, repo


install_fakes()
from worksuite_polkit_agent import agent  # noqa: E402


class FakeLockout:
    def failed(self, *_a):
        return {"locked": False, "remaining": 4}

    def succeeded(self, _u):
        pass

    def state(self, _u):
        return {"locked": False}


class FakeAgent:
    def __init__(self):
        self.lockout, self.sent, self.requests = FakeLockout(), [], {}
        self.shell = types.SimpleNamespace(send=lambda m: self.sent.append(m) or True)


class FakeTask:
    def __init__(self):
        self.result = None

    def return_boolean(self, v):
        self.result = v


class LifetimeTests(unittest.TestCase):
    def setUp(self):
        FakeGLib.idle.clear()
        FakeSession.made.clear()
        self.task = FakeTask()
        self.r = agent.Request(FakeAgent(), self.task, "a", "m", "", {}, "cookie", (1000, "alex", "Alex"))
        self.r.start_session()

    def test_failed_try_keeps_session_until_idle_and_retries_from_idle(self):
        first = self.r.session
        ref = weakref.ref(first)
        del first
        ref().emit_completed(False)
        self.assertIsNotNone(ref(), "session freed while still emitting")
        self.assertEqual(len(FakeSession.made), 1, "retry session started inside the signal handler")
        FakeGLib.run_idle()
        self.assertIsNone(ref(), "old session never released")
        self.assertIsNotNone(self.r.session)
        self.assertIsNot(self.r.session, None)
        self.assertEqual(len(FakeSession.made), 2)

    def test_success_keeps_session_until_idle(self):
        s = self.r.session
        ref = weakref.ref(s)
        del s
        ref().emit_completed(True)
        self.assertTrue(self.task.result)
        self.assertIsNotNone(ref())
        FakeGLib.run_idle()
        self.assertIsNone(ref())
        self.assertEqual(len(FakeSession.made), 1, "no retry after success")

    def test_cancel_after_failure_does_not_restart(self):
        ref = weakref.ref(self.r.session)
        ref().emit_completed(False)
        self.r.task, task = None, self.r.task  # finished (cancelled) before idle ran
        FakeGLib.run_idle()
        self.assertEqual(len(FakeSession.made), 1)


if __name__ == "__main__":
    unittest.main()
