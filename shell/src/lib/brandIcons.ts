// Icons for the apps WorkSuite OS knows by id: WorkSuite Desktop's app icon and WorkSuite Office's icon (bundled from
// Livezen-Technologies/worksuite-desktop resources/icons and worksuite-office branding/icon), WorkSuite modules in
// WorkSuite Desktop's own glyphs and colours (its src/modules/registry.ts icons and src/core/app-look.ts colours),
// and the OS's own apps in the design canvas's tile colours (Start menu board G02). Glyphs are white on the colour.
import worksuitePng from '../assets/brand/worksuite.png'
import officeSvg from '../assets/brand/worksuite-office.svg'
import { GLYPHS } from './appGlyphs'
import whatsappSvg from '../../apps/icons/lk.worksuite.whatsapp.svg'

/** WorkSuite module id → [glyph, colour], as WorkSuite Desktop draws the module. Drive is its Files. */
export const MODULE_ICONS: Record<string, [string, string]> = {
  home: ['house', '#23349E'],
  mail: ['mail', '#1D4ED8'],
  chat: ['message-square', '#0F766E'],
  calendar: ['calendar', '#B91C1C'],
  tasks: ['square-check', '#6D28D9'],
  files: ['folder', '#D97706'],
  drive: ['folder', '#D97706'],
  projects: ['kanban', '#3730A3'],
  notes: ['notebook', '#CA8A04'],
  contacts: ['contact', '#0D9488'],
  crm: ['users', '#DC2626'],
  hr: ['id-card', '#9333EA'],
  meet: ['video', '#0369A1'],
  pdf: ['file-text', '#23349E'],
  'pdf-studio': ['file-text', '#23349E'],
}

/** The OS's own apps and WorkSuite Office's new-document tiles, in the canvas's colours. */
export const SYSTEM_ICONS: Record<string, [string, string]> = {
  appcenter: ['layout-grid', '#1F6BFF'],
  monitor: ['activity', '#2E9E6A'],
  settings: ['settings', '#5E739C'],
  files: ['folder', '#0E8FA8'],
  assistant: ['sparkles', '#0E7490'],
  recovery: ['life-buoy', '#D9452B'],
  'office-docs': ['file-text', '#1F6BFF'],
  'office-sheets': ['sheet', '#2E9E6A'],
  'office-slides': ['presentation', '#D9572B'],
}

/** A 48×48 tile: the glyph in white on the colour, as an SVG data: URL. */
export function glyphTile(glyph: string, colour: string): string | null {
  const g = GLYPHS[glyph]
  if (!g || !/^#[0-9A-Fa-f]{6}$/.test(colour)) return null
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="${colour}"/>`
    + `<g transform="translate(12 12)" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${g}</g></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const tiles = new Map<string, string | null>()
const tile = (k: string, [g, c]: [string, string]) => { if (!tiles.has(k)) tiles.set(k, glyphTile(g, c)); return tiles.get(k)! }

/** The bundled icon for a launcher id (worksuite-desktop, office, worksuite-<module>, system apps), or null. */
export function brandIcon(id: string): string | null {
  if (id === 'worksuite-desktop') return worksuitePng
  if (id === 'office') return officeSvg
  if (id === 'lk.worksuite.whatsapp') return whatsappSvg
  if (SYSTEM_ICONS[id]) return tile(id, SYSTEM_ICONS[id])
  const m = /^worksuite-(.+)$/.exec(id)
  if (m && MODULE_ICONS[m[1]]) return tile(`m:${m[1]}`, MODULE_ICONS[m[1]])
  return null
}
