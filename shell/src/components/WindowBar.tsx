// The title bar of WorkSuite's own windows under GNOME (Settings, Setup). The main process creates them with
// titleBarStyle 'hidden' and a titleBarOverlay: Electron itself draws the real minimize/maximize/close buttons (native
// hit-testing, Wayland move/resize, keyboard and screen-reader behaviour unchanged), recoloured to the WorkSuite navy.
// This bar is only the draggable strip under them, with the title centred; double-click maximizes, as on any GNOME
// window. No button here is drawn by the page, so none can be a fake. Always dark (ws-dark-zone): the native buttons
// keep the overlay colours whatever the page theme is.
export const WINDOW_BAR_HEIGHT = 40

export function WindowBar({ title }: { title: string }) {
  return (
    <header
      // Drag region for the compositor; the overlay's buttons sit on top at the right (titlebar-area-* env vars).
      style={{ height: WINDOW_BAR_HEIGHT, WebkitAppRegion: 'drag', paddingRight: 'calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px))' } as React.CSSProperties}
      className="ws-dark-zone relative flex shrink-0 items-center justify-center border-b border-[rgba(127,178,255,0.10)] bg-[#061029] select-none"
    >
      <span className="pointer-events-none flex items-center gap-2 text-[13px] font-semibold tracking-[0.01em] text-[#DCE6F8]">
        <svg aria-hidden width="14" height="14" viewBox="0 0 960 960"><rect x="320" y="0" width="640" height="640" rx="110" fill="#2F7BFF" /><rect x="0" y="320" width="320" height="320" rx="70" fill="#3FDDF5" /><rect x="320" y="640" width="320" height="320" rx="70" fill="#3FDDF5" /><rect x="320" y="320" width="320" height="320" rx="50" fill="#0D2B66" /></svg>
        {title}
      </span>
    </header>
  )
}
