// WorkSuite loading icon (brand loaders, 10 variants; artwork from the WorkSuite loaders pack). Every wait in the shell
// shows the WorkSuite mark assembling instead of a generic ring. The SVG is drawn as an <img> from a data: URL, so
// its <style> (class names like .m, .b) stays inside the image and cannot restyle the page; CSS animation still
// runs in an SVG image, and prefers-reduced-motion inside it shows the still logo.
// The boot splash (branding/plymouth/worksuite.script) plays the same "assemble" motion natively.
// Inner SVG markup (viewBox 0 0 128 128). Each variant uses its own class names.
import { t } from '../i18n'

import { MARKUP, type WorkSuiteLoaderVariant } from './loaderMarkup'

export { MARKUP, type WorkSuiteLoaderVariant }
export const LOADER_VARIANTS = Object.keys(MARKUP) as WorkSuiteLoaderVariant[]

/** The variant as a standalone SVG document (data: URL). */
export function loaderSrc(variant: WorkSuiteLoaderVariant): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${MARKUP[variant]}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

type Props = { variant?: WorkSuiteLoaderVariant; size?: number; label?: string; className?: string; decorative?: boolean }

/** <WorkSuiteLoader /> 48 px "assemble"; decorative hides it from screen readers (inside a busy button, say). */
export function WorkSuiteLoader({ variant = 'assemble', size = 48, label, className = '', decorative = false }: Props) {
  const img = <img src={loaderSrc(variant)} width={size} height={size} alt="" aria-hidden="true" draggable={false} className="block shrink-0 select-none" />
  if (decorative) return <span className={`inline-flex shrink-0 ${className}`} aria-hidden="true">{img}</span>
  return (
    <span role="status" aria-live="polite" className={`inline-flex flex-col items-center gap-3 ${className}`}>
      {img}
      {label ? <span className="text-[13px] font-medium text-[#8FA3C8]">{label}</span> : <span className="sr-only">{t('common.loading')}</span>}
    </span>
  )
}
