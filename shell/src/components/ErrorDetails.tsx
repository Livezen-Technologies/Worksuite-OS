// The technical side of an error (lib/errors.ts `details`): administrators can open it; everyone else gets a
// "Copy details" button for their helpdesk, without the text on screen.
import { useState } from 'react'
import { useIsAdmin } from '../lib/sessionApi'
import { t } from '../i18n'

export function ErrorDetails({ details, className = '' }: { details: string | null | undefined; className?: string }) {
  const admin = useIsAdmin()
  const [copied, setCopied] = useState(false)
  if (!details) return null
  const copy = () => { void navigator.clipboard?.writeText(details).then(() => setCopied(true)).catch(() => {}) }
  const copyBtn = (
    <button type="button" onClick={copy} className="cursor-pointer self-start rounded-md border border-[rgba(127,178,255,0.25)] px-2 py-1 text-[11px] text-[#C9D6EE] hover:bg-white/[0.06]">
      {copied ? t('err.copied') : t('err.copyDetails')}
    </button>
  )
  if (!admin) return <span className={`flex ${className}`}>{copyBtn}</span>
  return (
    <details className={`flex flex-col gap-1.5 text-[11px] text-[#8FA3C8] ${className}`}>
      <summary className="cursor-pointer select-none text-[#7FB2FF] hover:text-[#B8D4FF]">{t('err.showDetails')}</summary>
      <pre className="m-0 max-h-40 overflow-auto rounded-md bg-[rgba(4,10,26,0.7)] p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-[#C9D6EE]">{details}</pre>
      {copyBtn}
    </details>
  )
}
