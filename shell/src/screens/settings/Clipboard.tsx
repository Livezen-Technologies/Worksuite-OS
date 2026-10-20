// Settings › Clipboard (like Windows' System › Clipboard): clipboard history on or off (off until the person turns it
// on), Clear clipboard data, and what is kept where. Policy clipboard_history: disabled (or a kiosk) turns it off.
import { useEffect, useState, type ReactNode } from 'react'
import { Svg, btnGhost, card, rowLine } from '../../components/Dk'
import { desktopApi, type ClipState } from '../../lib/desktopApi'
import { t, formatNumber } from '../../i18n'
import { BigSwitch, H1, Note } from './ui'
import { Keys } from '../../components/ShortcutHelp'

const CLIP = 'M9 4h6v3H9zM7 5H5v16h14V5h-2'

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex min-h-[56px] items-center gap-4 px-5 py-3 ${rowLine}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-semibold">{title}</span>{sub && <span className="text-xs leading-[1.45] text-[#8FA3C8]">{sub}</span>}</span>
      {children}
    </div>
  )
}

export function ClipboardPanel({ initial }: { initial?: ClipState | null }) {
  const [s, setS] = useState<ClipState | null>(initial ?? null)
  const [cleared, setCleared] = useState(false)
  useEffect(() => {
    if (initial !== undefined || !desktopApi) return
    void desktopApi.clipboardState().then(setS).catch(() => {})
    return desktopApi.onClipboard(setS)
  }, [initial])
  const api = desktopApi
  const pinned = s?.entries.filter((e) => e.pinned).length ?? 0
  return <>
    <H1>{t('settings.nav.Clipboard')}</H1>
    {s?.blocked && <p role="status" className="m-0 rounded-xl border border-[rgba(217,69,43,0.35)] bg-[rgba(217,69,43,0.12)] px-4 py-3 text-[13px] text-[#FFB4A6]">{t('clip.blocked')}</p>}
    {!api && initial === undefined ? <Note>{t('flyout.unavailable')}</Note> : (
      <div className={card}>
        <Row title={t('clip.title')} sub={<>{t('clip.historySub')} <Keys k="W-v" small /></>}>
          <BigSwitch label={t('clip.title')} checked={!!s?.enabled} disabled={!s} unavailable={s?.blocked ? t('clip.blocked') : undefined} onChange={(v) => api?.clipboardSetEnabled(v).then(setS)} />
        </Row>
        <Row title={t('clip.clearData')} sub={cleared ? t('clip.clearedNote') : t('clip.clearDataSub')}>
          <button type="button" className={`${btnGhost} gap-2`} disabled={!s?.entries.some((e) => !e.pinned)} onClick={() => void api?.clipboardClear().then((x) => { setS(x); setCleared(true) })}>
            {cleared && <Svg d="M5 12l5 5L20 7" size={16} stroke="#2E9E6A" />}{t('clip.clearButton')}
          </button>
        </Row>
        <Row title={t('clip.pinnedTitle')} sub={s?.persist ? t('clip.pinnedSaved') : t('clip.pinnedSession')}>
          <span className="flex items-center gap-3">
            <span className="text-[13px] text-[#C9D6EE]">{t('clip.pinnedCount', { count: formatNumber(pinned) })}</span>
            <button type="button" className={btnGhost} disabled={!pinned} onClick={() => void api?.clipboardClear(true).then(setS)}>{t('clip.clearPinned')}</button>
          </span>
        </Row>
      </div>
    )}
    <div className={`${card} flex items-start gap-3 px-5 py-4`}>
      <Svg d={CLIP} size={20} stroke="#18D4F0" />
      <Note>{t('clip.privacyNote')}</Note>
    </div>
  </>
}
