// Ask Settings to show a section (from a toast's "Details", the taskbar update button, …). Settings reads the
// pending request when it mounts and listens while it is open.
let pending: string | null = null
const EVENT = 'ws:settings-section'

export function requestSettingsSection(section: string) {
  pending = section
  window.dispatchEvent(new CustomEvent(EVENT, { detail: section }))
}
export function takeSettingsSection(): string | null { const s = pending; pending = null; return s }
export function onSettingsSection(cb: (s: string) => void): () => void {
  const l = (e: Event) => { pending = null; cb(String((e as CustomEvent).detail)) }
  window.addEventListener(EVENT, l)
  return () => window.removeEventListener(EVENT, l)
}
