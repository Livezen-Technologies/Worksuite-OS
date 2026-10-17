"""Where the keyboard's layer surface goes (ui.OskWindow.place), without GTK so it is unit tested.

Labwc arranges the overlay layer, the keyboard's, before the bottom layer, where the Wayland bridge reserves the
shell's taskbar (native/wayland-bridge/worksuite_bridge/layer.py, WORKSUITE_PANEL_HEIGHT): a docked keyboard anchored
to the bottom edge therefore covered the taskbar. It sits on the taskbar instead (bottom margin = panel height). The
compositor reserves exclusive zone + margin; the bridge's reservation then lands on top of that, so the keyboard asks
for its height less the panel's and apps end exactly at the keyboard's top edge.
"""
import os

HEIGHT = {"small": 200, "medium": 260, "large": 340}


def panel_height(kiosk: bool, env=os.environ) -> int:
    """The taskbar's height (no taskbar in kiosk mode)."""
    if kiosk:
        return 0
    try:
        return max(0, int(env.get("WORKSUITE_PANEL_HEIGHT", "56")))
    except ValueError:
        return 56


def docked(size: str, panel: int) -> tuple[int, int]:
    """(bottom margin, exclusive zone) of the docked or split keyboard."""
    return panel, max(1, HEIGHT[size] - panel)
