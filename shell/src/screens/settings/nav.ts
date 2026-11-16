// The Settings sections, their labels and older names (from Settings.tsx).
import { t, type MessageKey } from '../../i18n'

export const NAV = [
  { id: 'Network', tint: '#1F6BFF', icon: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0' },
  { id: 'VPN', tint: '#2E9E6A', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4' },
  { id: 'Bluetooth', tint: '#1F6BFF', icon: 'M7 7l10 10-5 5V2l5 5L7 17' },
  { id: 'Display', tint: '#0E8FA8', icon: 'M3 4h18v12H3zM8 20h8M12 16v4', sep: true },
  { id: 'Graphics', tint: '#0E8FA8', icon: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4' },
  { id: 'Touchscreen & pen', tint: '#0E8FA8', icon: 'M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2.5-4.5a1.5 1.5 0 0 1 2.6-1.5L8 15' },
  { id: 'Mouse & touchpad', tint: '#0E8FA8', icon: 'M12 3a6 6 0 0 0-6 6v6a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6zM12 3v7M6 10h12' },
  { id: 'Multitasking', tint: '#0E8FA8', icon: 'M3 5h8v6H3zM13 5h8v6h-8zM3 15h18v4H3z' },
  { id: 'Keyboard', tint: '#7A4FE0', icon: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10' },
  { id: 'Appearance', tint: '#7A4FE0', icon: 'M12 3a9 9 0 1 0 9 9c0-1.5-1.3-2-2.5-2H16a2 2 0 0 1 0-4h.5A9 9 0 0 0 12 3z' },
  { id: 'Sound', tint: '#D9572B', icon: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7' },
  { id: 'Notifications', tint: '#D9452B', icon: 'M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0' },
  { id: 'Clipboard', tint: '#0E8FA8', icon: 'M9 4h6v3H9zM7 5H5v16h14V5h-2' },
  { id: 'Power', tint: '#B7791F', icon: 'M13 2L4 14h7l-1 8 9-12h-7z' },
  { id: 'Printers', tint: '#5E739C', icon: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z' },
  { id: 'Default apps', tint: '#0E8FA8', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 16.5h7M16.5 13v7' },
  { id: 'AI', tint: '#7A4FE0', icon: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z' },
  { id: 'Privacy & security', tint: '#2E9E6A', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', sep: true },
  { id: 'Lock screen', tint: '#2E9E6A', icon: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z' },
  { id: 'Users', tint: '#5E739C', icon: 'M9 8a3.5 3.5 0 1 0 0 .01M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5M16 4.5a3.5 3.5 0 0 1 0 7' },
  { id: 'Devices', tint: '#5E739C', icon: 'M4 6h16v10H4zM2 20h20', sep: true },
  { id: 'Drivers', tint: '#5E739C', icon: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z' },
  { id: 'Updates', tint: '#1F6BFF', icon: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4' },
  { id: 'Managed', tint: '#7A4FE0', icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 10h.01M15 10h.01M9 14h.01M15 14h.01' },
  { id: 'About', tint: '#5E739C', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01' },
] as const
export type Section = (typeof NAV)[number]['id']
export const isSection = (s: string | null): s is Section => NAV.some((n) => n.id === s)
export const navLabel = (id: Section) => t(`settings.nav.${id}` as MessageKey)
// Older names (launcher search, earlier builds) still land somewhere sensible.
export const ALIAS: Record<string, Section> = { 'About this device': 'About', Accounts: 'Users', Privacy: 'Privacy & security', Displays: 'Display', Mouse: 'Mouse & touchpad', Touchpad: 'Mouse & touchpad', Pointer: 'Mouse & touchpad', Lock: 'Lock screen', Management: 'Managed', Battery: 'Power', Touch: 'Touchscreen & pen', Pen: 'Touchscreen & pen', 'On-screen keyboard': 'Keyboard', 'AI assistant': 'AI', Assistant: 'AI', Desktops: 'Multitasking', 'Task View': 'Multitasking', Shortcuts: 'Keyboard', 'Keyboard shortcuts': 'Keyboard', 'Clipboard history': 'Clipboard', GPU: 'Graphics', 'Hardware acceleration': 'Graphics' }
