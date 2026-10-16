"""Touch gesture recognizer: multi-touch contacts in, gestures out. Pure, no I/O, so every rule is testable.

Coordinates are normalised to 0..1 of the touchscreen (x right, y down); times are seconds.

  edge swipes   one finger that starts within EDGE of the bottom, left or right edge and travels inward at least
                SWIPE of the screen: "edge-bottom", "edge-left", "edge-right"
  three fingers three contacts down together whose centre travels at least SWIPE: "three-left", "three-right",
                "three-up", "three-down" (the dominant direction)

Labwc 0.8 has no touch gesture bindings and libinput reports no gestures for touchscreens (only touchpads), so this
runs in a small user daemon (worksuite_gestures.daemon) on the evdev multitouch stream.
"""
from __future__ import annotations

from dataclasses import dataclass, field

EDGE = 0.04       # start zone: 4 % of the screen from the edge
SWIPE = 0.12      # travel to count as a swipe
MAX_TIME = 1.2    # a gesture slower than this is a drag, not a swipe


@dataclass
class Contact:
    x0: float
    y0: float
    t0: float
    x: float
    y: float


@dataclass
class Recognizer:
    contacts: dict[int, Contact] = field(default_factory=dict)
    max_fingers: int = 0
    start: float = 0.0
    centre0: tuple[float, float] | None = None
    fired: bool = False

    def down(self, slot: int, x: float, y: float, t: float) -> None:
        if not self.contacts:
            self.max_fingers, self.start, self.fired, self.centre0 = 0, t, False, None
        self.contacts[slot] = Contact(x, y, t, x, y)
        self.max_fingers = max(self.max_fingers, len(self.contacts))
        if len(self.contacts) == 3:
            self.centre0 = self._centre()

    def move(self, slot: int, x: float, y: float, t: float) -> str | None:
        c = self.contacts.get(slot)
        if c is None:
            return None
        c.x, c.y = x, y
        if self.fired or t - self.start > MAX_TIME:
            return None
        g = self._three() if self.max_fingers == 3 and len(self.contacts) == 3 else self._edge() if self.max_fingers == 1 else None
        if g:
            self.fired = True
        return g

    def up(self, slot: int, t: float) -> None:
        self.contacts.pop(slot, None)

    def _centre(self) -> tuple[float, float]:
        n = len(self.contacts)
        return (sum(c.x for c in self.contacts.values()) / n, sum(c.y for c in self.contacts.values()) / n)

    def _three(self) -> str | None:
        if self.centre0 is None:
            return None
        cx, cy = self._centre()
        dx, dy = cx - self.centre0[0], cy - self.centre0[1]
        if max(abs(dx), abs(dy)) < SWIPE:
            return None
        if abs(dx) >= abs(dy):
            return "three-right" if dx > 0 else "three-left"
        return "three-down" if dy > 0 else "three-up"

    def _edge(self) -> str | None:
        (c,) = self.contacts.values()
        if c.y0 >= 1 - EDGE and c.y0 - c.y >= SWIPE:
            return "edge-bottom"
        if c.x0 <= EDGE and c.x - c.x0 >= SWIPE:
            return "edge-left"
        if c.x0 >= 1 - EDGE and c.x0 - c.x >= SWIPE:
            return "edge-right"
        return None


# ---- settings → actions ---------------------------------------------------------------------------------------
ACTIONS = ("launcher", "notifications", "switch-apps", "workspaces", "desktop", "off")
DEFAULTS = {"edgeBottom": "launcher", "edgeRight": "notifications", "edgeLeft": "switch-apps", "threeHorizontal": "workspaces", "threeDown": "desktop"}
ALLOWED = {
    "edgeBottom": ("launcher", "off"),
    "edgeRight": ("notifications", "off"),
    "edgeLeft": ("switch-apps", "off"),
    "threeHorizontal": ("workspaces", "switch-apps", "off"),
    "threeDown": ("desktop", "off"),
}


def normalize(cfg: object) -> dict:
    """gestures.json as the shell writes it (shell/electron/touch.ts): unknown or bad values fall back to defaults."""
    o = cfg if isinstance(cfg, dict) else {}
    out = {k: (o.get(k) if o.get(k) in ALLOWED[k] else v) for k, v in DEFAULTS.items()}
    out["enabled"] = o.get("enabled", True) is not False
    out["edgeSwipes"] = o.get("edgeSwipes", True) is not False
    return out


def plan(gesture: str, cfg: dict) -> tuple[str, str] | None:
    """(action, argument) for a gesture under the settings, or None."""
    if not cfg.get("enabled", True):
        return None
    if gesture.startswith("edge-") and not cfg.get("edgeSwipes", True):
        return None
    key = {"edge-bottom": "edgeBottom", "edge-right": "edgeRight", "edge-left": "edgeLeft",
           "three-left": "threeHorizontal", "three-right": "threeHorizontal", "three-down": "threeDown"}.get(gesture)
    action = cfg.get(key) if key else None
    if not action or action == "off":
        return None
    direction = "left" if gesture == "three-left" else "right" if gesture == "three-right" else ""
    return action, direction


# Fixed argument lists; nothing from the touch stream reaches a command line.
SHELL = ["busctl", "--user", "--timeout=2", "call", "lk.worksuite.Shell1", "/lk/worksuite/Shell1", "lk.worksuite.Shell1"]


def command(action: str, direction: str) -> list[str] | None:
    if action == "launcher":
        return SHELL + ["ShowLauncher"]
    if action == "notifications":
        return SHELL + ["ToggleNotifications"]
    if action == "desktop":
        return SHELL + ["ShowDesktop"]
    if action == "switch-apps":
        # Labwc's A-Tab NextWindow binding (services/session/labwc/rc.xml), through the virtual keyboard.
        return ["wtype", "-M", "alt", "-k", "Tab", "-m", "alt"] if direction != "left" else ["wtype", "-M", "alt", "-M", "shift", "-k", "Tab", "-m", "shift", "-m", "alt"]
    if action == "workspaces":
        # Swipe left shows the workspace to the right, like moving a page. C-A-Left/Right are Labwc desktop bindings
        # that also report to the Wayland bridge (worksuite-workspace-event).
        return ["wtype", "-M", "ctrl", "-M", "alt", "-k", "Right" if direction == "left" else "Left", "-m", "alt", "-m", "ctrl"]
    return None
