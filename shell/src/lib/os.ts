// Typed renderer API. In Electron the preload exposes `window.worksuite` with named functions only
// (WSOS-SEC-001, §10.3); in a plain browser (dev/design review) a local stub answers instead.
// Split by area: osApi (the API), osTypes and osDevice (its types), osFormat (text helpers), osStub (browser preview).
import { withAppCenterPreview } from './appcenterPreview'
import type { WorkSuiteApi } from './osApi'
import { stub } from './osStub'
export * from './osApi'
export * from './osTypes'
export * from './osDevice'
export * from './osFormat'

export const os: WorkSuiteApi = (typeof window !== 'undefined' && window.worksuite) || withAppCenterPreview(stub)
