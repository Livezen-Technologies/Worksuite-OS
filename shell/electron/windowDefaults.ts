// What every ordinary app window the shell's Electron opens has in common (issues #15, #33): the compositor's frame
// (Labwc server-side decorations: the WorkSuite title bar with Minimize, Maximize/Restore and Close, drag to move,
// edges to resize), never a frameless or fixed-size window, and one minimum size. Full-screen shell surfaces (desktop,
// kiosk, overlays) are not app windows and set their own options.
export const APP_WINDOW = { frame: true, resizable: true, minimizable: true, maximizable: true, minWidth: 480, minHeight: 360, autoHideMenuBar: true } as const
