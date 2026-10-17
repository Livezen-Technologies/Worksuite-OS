// Taskbar button that shows or hides the on-screen keyboard (wvkbd through electron/touch.ts). Shown when the
// keyboard is not switched off in Settings › Keyboard.
import { touchApi, useTouch } from '../lib/touch'
import { t } from '../i18n'

export function OskButton() {
  const { state } = useTouch()
  if (!state || state.settings.osk === 'off') return null
  const shown = state.osk.visible
  return (
    <button type="button" aria-label={shown ? t('osk.hide') : t('osk.showNow')} aria-pressed={shown} title={state.osk.available ? undefined : t('osk.missing')}
      onMouseDown={(e) => e.preventDefault() /* keep focus in the text field being typed into */}
      onClick={() => { const api = touchApi(); void (api?.oskToggle ? api.oskToggle() : api?.osk(!shown)) }}
      className={`flex size-9 cursor-pointer items-center justify-center rounded-[10px] ${shown ? 'bg-white/20' : 'hover:bg-white/10'}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10" /></svg>
    </button>
  )
}
