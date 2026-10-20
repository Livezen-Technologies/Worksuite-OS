// Renderer side of electron/appPermissions.ts (issue #21). Outside Electron there is no bridge.
export type StoreResource = 'camera' | 'microphone' | 'location' | 'notifications' | 'screenshot' | 'background'
export const STORE_RESOURCES: StoreResource[] = ['camera', 'microphone', 'location', 'notifications', 'screenshot', 'background']
export interface Grant { resource: StoreResource; app: string; allowed: boolean; locked: boolean }
export interface Enforcement { mechanism: string; scope: 'sandboxed' | 'all' | 'none'; stored: boolean }
export interface PermEvent { at: number; app: string; resource: string; action: 'allowed' | 'denied' | 'removed' | 'reset' | 'policy_denied'; by: 'user' | 'app_request' | 'policy' }
export interface InUse { camera: string[]; microphone: string[] }
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export interface AppPermsApi {
  state(): Promise<Reply<{ grants: Grant[]; inUse: InUse; enforcement: Record<string, Enforcement> }>>
  set(resource: StoreResource, app: string, allow: boolean): Promise<Reply<true>>
  revoke(resource: StoreResource, app: string): Promise<Reply<true>>
  reset(app: string): Promise<Reply<true>>
  recent(): Promise<PermEvent[]>
  inUse(): Promise<InUse>
}

declare global {
  interface Window { worksuiteAppPerms?: AppPermsApi }
}

export const appPermsApi = (): AppPermsApi | undefined => (typeof window !== 'undefined' ? window.worksuiteAppPerms : undefined)

/** Grants → one row per app, resources in a fixed order. */
export function byApp(grants: Grant[]): { app: string; grants: Grant[] }[] {
  const m = new Map<string, Grant[]>()
  for (const g of grants) m.set(g.app, [...(m.get(g.app) ?? []), g])
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([app, gs]) => ({ app, grants: gs.sort((x, y) => STORE_RESOURCES.indexOf(x.resource) - STORE_RESOURCES.indexOf(y.resource)) }))
}
