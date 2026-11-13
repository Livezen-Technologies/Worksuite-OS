// What setup installs: the person's selection, plus what the organization makes mandatory, minus what it restricts,
// plus the dependencies of everything kept, in an order where dependencies come first. Pure; the engine runs it.
import { CATALOG, type AppDef } from './catalog.ts'

/** The parts of the device policy (/run/worksuite-device-agent/policy.json) setup reads. */
export interface AppPolicy {
  /** Catalog ids installed whatever the person picks. */
  setup_mandatory_apps?: string[]
  /** Catalog ids never installed by setup. Core apps (WorkSuite Desktop) cannot be restricted. */
  setup_restricted_apps?: string[]
  /** Software Management: 'block' allows no third-party apps; 'approved'/'request' only those on the allowlist. */
  software_install?: 'any' | 'approved' | 'request' | 'block'
  /** App Center allowlist ids ("apt:vlc", "flatpak:org.gimp.GIMP") or setup ids ("setup:vlc"). */
  app_allowlist?: string[]
}

export type Reason = 'core' | 'selected' | 'mandatory' | 'dependency'
export interface Planned { app: AppDef; reason: Reason; required: boolean }
export interface Skipped { id: string; why: 'restricted' | 'not_allowed' | 'unknown' }
export interface Plan { install: Planned[]; skipped: Skipped[] }

function allowedThirdParty(app: AppDef, p: AppPolicy): boolean {
  const mode = p.software_install ?? 'any'
  if (mode === 'any') return true
  if (mode === 'block') return false
  const allow = new Set(p.app_allowlist ?? [])
  return allow.has(`setup:${app.id}`) || app.sources.some((s) => allow.has(s.type === 'flatpak' ? `flatpak:${s.ref}` : `apt:${s.package}`))
}

export function plan(selection: readonly string[], policy: AppPolicy | null, catalog: readonly AppDef[] = CATALOG): Plan {
  const p = policy ?? {}
  const byId = new Map(catalog.map((a) => [a.id, a]))
  const restricted = new Set(p.setup_restricted_apps ?? [])
  const mandatory = new Set((p.setup_mandatory_apps ?? []).filter((id) => byId.has(id)))
  const skipped: Skipped[] = []
  const wanted = new Map<string, Reason>()
  for (const a of catalog) if (a.core) wanted.set(a.id, 'core')
  for (const id of mandatory) if (!wanted.has(id)) wanted.set(id, 'mandatory')
  for (const id of selection) {
    if (wanted.has(id)) continue
    const a = byId.get(id)
    if (!a) { skipped.push({ id, why: 'unknown' }); continue }
    wanted.set(id, 'selected')
  }
  // Policy: restriction wins over a selection; core apps and the organization's own mandatory list are kept.
  for (const [id, reason] of [...wanted]) {
    if (reason === 'core' || reason === 'mandatory') continue
    const a = byId.get(id)!
    if (restricted.has(id)) { wanted.delete(id); skipped.push({ id, why: 'restricted' }) }
    else if (a.group === 'third-party' && !allowedThirdParty(a, p)) { wanted.delete(id); skipped.push({ id, why: 'not_allowed' }) }
  }
  // Dependencies first (depth-first), each once; a cycle or a missing dependency is a catalog bug, reported plainly.
  const out: Planned[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string, reason: Reason) => {
    if (done.has(id)) return
    if (visiting.has(id)) throw new Error(`application dependency cycle at ${id}`)
    const a = byId.get(id)
    if (!a) throw new Error(`unknown application dependency ${id}`)
    visiting.add(id)
    for (const d of a.requires ?? []) visit(d, wanted.get(d) ?? 'dependency')
    visiting.delete(id); done.add(id)
    out.push({ app: a, reason, required: reason === 'core' || reason === 'mandatory' })
  }
  // Required apps go first so a later optional failure cannot delay them.
  const order = [...wanted].sort(([, a], [, b]) => Number(b === 'core' || b === 'mandatory') - Number(a === 'core' || a === 'mandatory'))
  for (const [id, reason] of order) visit(id, reason)
  // A dependency of a required app is required too.
  const requiredIds = new Set(out.filter((x) => x.required).map((x) => x.app.id))
  const need = (id: string): string[] => (byId.get(id)?.requires ?? []).flatMap((d) => [d, ...need(d)])
  for (const id of [...requiredIds]) for (const d of need(id)) requiredIds.add(d)
  return { install: out.map((x) => ({ ...x, required: requiredIds.has(x.app.id) })), skipped }
}
