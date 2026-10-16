// An app's icon wherever apps are listed (Start menu, All apps, taskbar, search, App Center): the bundled WorkSuite /
// system icon for apps the OS knows by id, else the installed app's theme icon (Icon= of its desktop entry), else the
// generated letter mark. Always decorative: the control around it carries the app's name.
import type { CSSProperties } from 'react'
import { brandIcon } from '../lib/brandIcons'
import { useThemeIcon } from '../lib/appIcons'

export interface GlyphApp { id: string; name?: string; mark: string; bg: string; fg: string; icon?: string | null }

/**
 * size: px. radius and font: the letter mark's corner radius and font size. css: draw the mark's letters with CSS
 * (data-mark) so they never join the button's accessible name (taskbar, WCAG 2.5.3). className/style: the mark's.
 */
export function AppGlyph({ app, size, radius, font, css = false, className = '', style }: { app: GlyphApp; size: number; radius: number; font: number; css?: boolean; className?: string; style?: CSSProperties }) {
  const brand = brandIcon(app.id)
  const theme = useThemeIcon(brand ? null : app.icon, size)
  const src = brand ?? theme
  if (src) {
    return <img aria-hidden="true" alt="" src={src} width={size} height={size} draggable={false} data-icon={app.id} className="ws-icon shrink-0 select-none object-contain" style={{ width: size, height: size }} />
  }
  // Still loading: keep the space without flashing the letter mark.
  if (theme === undefined && app.icon && !brand) return <span aria-hidden="true" className="ws-icon shrink-0" style={{ width: size, height: size }} />
  const base = `ws-mark flex shrink-0 items-center justify-center whitespace-nowrap leading-none font-bold ${className}`
  const st: CSSProperties = { width: size, height: size, borderRadius: radius, fontSize: font, background: app.bg, color: app.fg, ...style }
  return css
    ? <span aria-hidden="true" data-mark={app.mark} className={`${base} before:content-[attr(data-mark)]`} style={st} />
    : <span aria-hidden="true" className={base} style={st}>{app.mark}</span>
}
