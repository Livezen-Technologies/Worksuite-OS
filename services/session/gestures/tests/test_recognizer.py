"""Gesture recognition and actions (run: python3 -m unittest discover -s services/session/gestures -t services/session/gestures)."""
import unittest

from worksuite_gestures.recognizer import Recognizer, command, normalize, plan


def swipe(r, starts, dx, dy, steps=5, dt=0.05):
    t = 0.0
    for i, (x, y) in enumerate(starts):
        r.down(i, x, y, t)
    got = None
    for k in range(1, steps + 1):
        t += dt
        for i, (x, y) in enumerate(starts):
            g = r.move(i, x + dx * k / steps, y + dy * k / steps, t)
            got = got or g
    for i in range(len(starts)):
        r.up(i, t)
    return got


class RecognizerTest(unittest.TestCase):
    def test_edge_swipes(self):
        self.assertEqual(swipe(Recognizer(), [(0.5, 0.99)], 0, -0.3), "edge-bottom")
        self.assertEqual(swipe(Recognizer(), [(0.995, 0.5)], -0.3, 0), "edge-right")
        self.assertEqual(swipe(Recognizer(), [(0.01, 0.5)], 0.3, 0), "edge-left")
        # Not from the edge, or too short: nothing.
        self.assertIsNone(swipe(Recognizer(), [(0.5, 0.5)], 0, -0.3))
        self.assertIsNone(swipe(Recognizer(), [(0.5, 0.99)], 0, -0.05))

    def test_three_finger_swipes(self):
        three = [(0.4, 0.5), (0.5, 0.5), (0.6, 0.5)]
        self.assertEqual(swipe(Recognizer(), three, -0.3, 0), "three-left")
        self.assertEqual(swipe(Recognizer(), three, 0.3, 0.05), "three-right")
        self.assertEqual(swipe(Recognizer(), three, 0, 0.3), "three-down")
        self.assertIsNone(swipe(Recognizer(), [(0.4, 0.5), (0.6, 0.5)], -0.3, 0), "two fingers are the app's (scroll, pinch)")

    def test_one_gesture_per_touch_and_slow_drags_ignored(self):
        r = Recognizer()
        r.down(0, 0.5, 0.99, 0)
        self.assertEqual(r.move(0, 0.5, 0.8, 0.1), "edge-bottom")
        self.assertIsNone(r.move(0, 0.5, 0.5, 0.2))
        r.up(0, 0.3)
        self.assertIsNone(swipe(Recognizer(), [(0.5, 0.99)], 0, -0.3, steps=5, dt=0.7))


class ActionsTest(unittest.TestCase):
    def test_settings_and_plan(self):
        cfg = normalize({"edgeBottom": "off", "threeHorizontal": "switch-apps", "edgeRight": "rm -rf /"})
        self.assertIsNone(plan("edge-bottom", cfg))
        self.assertEqual(plan("edge-right", cfg), ("notifications", ""))
        self.assertEqual(plan("three-left", cfg), ("switch-apps", "left"))
        self.assertIsNone(plan("edge-left", normalize({"edgeSwipes": False})))
        self.assertIsNone(plan("three-down", normalize({"enabled": False})))
        self.assertEqual(normalize(None)["threeHorizontal"], "workspaces")

    def test_commands_are_fixed(self):
        self.assertEqual(command("launcher", "")[-1], "ShowLauncher")
        self.assertEqual(command("notifications", "")[-1], "ToggleNotifications")
        self.assertEqual(command("desktop", "")[-1], "ShowDesktop")
        self.assertIn("Right", command("workspaces", "left"))
        self.assertIn("Left", command("workspaces", "right"))
        self.assertEqual(command("switch-apps", "right"), ["wtype", "-M", "alt", "-k", "Tab", "-m", "alt"])
        self.assertIsNone(command("off", ""))


if __name__ == "__main__":
    unittest.main()
