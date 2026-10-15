import BIcon from './BIcon'

// Window chrome for shell apps rendered inside the desktop work area (above the taskbar).
export default function BWindow({ title, mark, markClass, label, bodyClass = 'bg-white', titleClass = 'bg-[#f8fafc]', onClose, children }: {
  title: string; mark: string; markClass: string; label: string; bodyClass?: string; titleClass?: string
  onClose: () => void; children: React.ReactNode
}) {
  return (
    <div role="application" aria-label={label} className={`flex h-full w-full flex-col overflow-hidden rounded-xl text-[#0f172a] shadow-[0_16px_48px_rgba(2,6,23,0.45)] ${bodyClass}`}>
      <div className={`flex h-11 shrink-0 items-center gap-2.5 border-b border-[#e2e8f0] pr-2 pl-4 ${titleClass}`}>
        <span className={`flex size-[22px] items-center justify-center rounded-md text-[11px] font-bold ${markClass}`}>{mark}</span>
        <span className="text-[13px] font-semibold">{title}</span>
        <div className="ml-auto flex gap-0.5">
          <button type="button" aria-label="Minimize" onClick={onClose} className="flex h-8 w-9 items-center justify-center rounded-md text-[#475569] hover:bg-[#e2e8f0]"><BIcon name="minimize" size={14} /></button>
          <button type="button" aria-label="Maximize" className="flex h-8 w-9 items-center justify-center rounded-md text-[#475569] hover:bg-[#e2e8f0]"><BIcon name="maximize" size={13} /></button>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-8 w-9 items-center justify-center rounded-md text-[#475569] hover:bg-[#fee2e2] hover:text-[#b91c1c]"><BIcon name="close" size={14} /></button>
        </div>
      </div>
      <div className="flex min-h-0 grow">{children}</div>
    </div>
  )
}
