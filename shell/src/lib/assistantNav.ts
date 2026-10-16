// Open the AI assistant from elsewhere in the shell: Files' "Explain with AI", "Ask AI" in search. Desktop listens
// and opens the panel; the request carries only where the text is, never the text (the panel reads it on the
// person's action, through electron/ai.ts).
export type AssistantRequest = { kind: 'open' } | { kind: 'ask'; text: string } | { kind: 'file'; root: string; rel: string }
const EVENT = 'ws:assistant'

export function requestAssistant(r: AssistantRequest = { kind: 'open' }) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: r }))
}
export function onAssistantRequest(cb: (r: AssistantRequest) => void): () => void {
  const l = (e: Event) => cb((e as CustomEvent).detail as AssistantRequest)
  window.addEventListener(EVENT, l)
  return () => window.removeEventListener(EVENT, l)
}
