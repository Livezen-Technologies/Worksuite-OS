// Desktop of a secondary monitor (WSOS-DSK-005): that monitor's wallpaper and a taskbar listing the windows on it.
// The main process opens one of these per extra output (electron/outputWindows.ts) and closes it on unplug.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTaskbarMirror } from '../lib/taskbarMirror'
import { RunningApps } from '../components/PanelItems'
import { EndMirror } from '../components/SessionEnd'
import { BG } from '../components/Ws'
import { useDisplayState, wallpaperFor, windowsOnOutput } from '../lib/displays'
import type { PanelWindow } from '../lib/panel'
import { formatTime, useT } from '../i18n'
import SnipOverlay from '../components/SnipOverlay'
import { captureApi, type SnipOpen } from '../lib/captureApi'

export default function OutputDesktop({ output }: { output: string }) {
  const t = useT()
  const display = useDisplayState()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(i) }, [])
  const only = useCallback((ws: PanelWindow[]) => windowsOnOutput(ws, output, false, []), [output])
  const time = formatTime(now)
  // #53: mirrored into this output's taskbar window, above the apps (lib/taskbarMirror.ts).
  const nav = useRef<HTMLElement>(null)
  useTaskbarMirror(nav, output)
  // The snipping overlay on this monitor too (electron/capture.ts lifts every shell window).
  const [snip, setSnip] = useState<SnipOpen | null>(null)
  useEffect(() => {
    const offs = [captureApi?.onSnipOpen(setSnip), captureApi?.onSnipClose(() => setSnip(null))]
    return () => offs.forEach((f) => f?.())
  }, [])
  return (
    <div className="relative h-full w-full overflow-hidden font-sans" style={{ background: wallpaperFor(display, output, BG.desktop) }} data-output={output}>
      <nav ref={nav} aria-label={t('panel.taskbar')} className="ws-taskbar absolute inset-x-0 bottom-0 z-40 box-border flex h-[52px] items-center gap-2 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(6,14,34,0.82)] px-4 text-[#E8EEFA] backdrop-blur-[20px]">
        <RunningApps pinned={[]} info={() => undefined} onLaunch={() => undefined} only={only} />
        <time className="ml-auto text-[13px]" dateTime={now.toISOString()}>{time}</time>
      </nav>
      <EndMirror />
      {snip && <SnipOverlay open={snip} output={output} />}
    </div>
  )
}
