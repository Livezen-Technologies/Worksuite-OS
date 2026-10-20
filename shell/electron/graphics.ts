// Hardware acceleration (#16): what renders the desktop and the WorkSuite apps, and the fallback to software.
// - The compositor (Labwc, cage) picks its renderer in services/session/bin/wlr-env: the GPU on real hardware, the CPU
//   (pixman) on virtual and basic display adapters, or what the person chose in Settings › Graphics
//   (~/.config/worksuite/graphics.conf). It tells the session which one it used in WORKSUITE_RENDERER.
// - Electron (the shell and every WorkSuite app window) uses the GPU for compositing, rasterization and video decoding
//   (VA-API) unless the compositor runs in software or the GPU process kept crashing: then it renders in software, so a
//   bad driver never leaves a black window. Settings shows the GPU, its driver, the graphics APIs and that status.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { listDevices } from './hardware'
import type { Exec } from './system'

export type RendererChoice = 'auto' | 'gpu' | 'software'
export interface Gpu { name: string; vendor: string | null; ids: string; driver: string | null; driver_version: string | null; proprietary: boolean | null; virtual: boolean }
export interface GraphicsState {
  gpus: Gpu[]
  compositor: { renderer: 'gpu' | 'software' | 'unknown'; reason: string | null; choice: RendererChoice; fell_back: boolean }
  apps: { accelerated: boolean; disabled_reason: 'software_session' | 'gpu_crashed' | 'choice' | null; features: Record<string, string>; gl_renderer: string | null; gl_version: string | null; driver_vendor: string | null; driver_version: string | null }
  vaapi: { available: boolean; driver: string | null; decode: string[]; encode: string[] }
  vulkan: { available: boolean; api_version: string | null; devices: { name: string; type: string; driver: string | null }[] }
}

/** Kernel display drivers of virtual and basic adapters (same list as wlr-env): no GPU acceleration by default. */
export const VIRTUAL_DRIVERS = new Set(['virtio_gpu', 'virtio-pci', 'qxl', 'bochs', 'bochs-drm', 'cirrus', 'cirrus-qemu', 'vboxvideo', 'vmwgfx', 'simpledrm', 'simple-framebuffer', 'efifb', 'hyperv_drm', 'mgag200', 'ast'])

const configHome = () => process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config')
const stateHome = () => process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state')
export const graphicsConfPath = () => path.join(configHome(), 'worksuite', 'graphics.conf')
/** Written by worksuite-session when the compositor failed on the GPU; wlr-env then starts it in software. */
export const rendererFallbackPath = () => path.join(stateHome(), 'worksuite', 'renderer-fallback')
/** Written here when Electron's GPU process kept crashing; the next start renders in software. */
export const gpuCrashPath = () => path.join(stateHome(), 'worksuite', 'gpu-crashes.json')

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf8') } catch { return null }
}
function writeAtomic(p: string, text: string) {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(`${p}.tmp`, text, { mode: 0o644 })
  renameSync(`${p}.tmp`, p)
}

/** graphics.conf: `renderer=auto|gpu|software` (shell syntax, read by wlr-env). */
export function parseGraphicsConf(text: string | null): RendererChoice {
  const v = text?.match(/^\s*renderer\s*=\s*"?(auto|gpu|software)"?\s*$/m)?.[1]
  return (v as RendererChoice | undefined) ?? 'auto'
}
export function readRendererChoice(): RendererChoice { return parseGraphicsConf(readText(graphicsConfPath())) }
export function writeRendererChoice(choice: RendererChoice) {
  writeAtomic(graphicsConfPath(), `# Settings › Graphics. auto: the GPU on real hardware, software on virtual adapters.\nrenderer=${choice}\n`)
}

// ---------- GPU crash fallback ----------
export interface CrashLog { crashes: number[]; disabled: boolean }
export const CRASH_WINDOW_MS = 10 * 60_000
export const CRASH_LIMIT = 3
export function parseCrashLog(text: string | null): CrashLog {
  try {
    const j = JSON.parse(text ?? '') as Partial<CrashLog>
    return { crashes: Array.isArray(j.crashes) ? j.crashes.filter((n) => typeof n === 'number') : [], disabled: j.disabled === true }
  } catch { return { crashes: [], disabled: false } }
}
/** One more GPU process crash at `now`: three inside ten minutes turn acceleration off from the next start. */
export function recordCrash(log: CrashLog, now: number): CrashLog {
  const crashes = [...log.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now].slice(-CRASH_LIMIT)
  return { crashes, disabled: log.disabled || crashes.length >= CRASH_LIMIT }
}
export function readCrashLog(): CrashLog { return parseCrashLog(readText(gpuCrashPath())) }
export function noteGpuCrash(now = Date.now()): CrashLog {
  const next = recordCrash(readCrashLog(), now)
  try { writeAtomic(gpuCrashPath(), JSON.stringify(next)) } catch { /* read-only home: Chromium still falls back in-process */ }
  return next
}

// ---------- Electron switches ----------
export interface AccelPlan { disable: boolean; reason: GraphicsState['apps']['disabled_reason']; switches: [string, string?][] }
/**
 * What Electron is started with. Software when the compositor runs in software (no usable GPU, or chosen), or after
 * repeated GPU crashes; otherwise GPU rasterization, zero-copy uploads and VA-API video decoding over Wayland.
 */
export function accelerationPlan(env: NodeJS.ProcessEnv, crashes: CrashLog, choice: RendererChoice): AccelPlan {
  if (choice === 'software') return { disable: true, reason: 'choice', switches: [] }
  if (env.WORKSUITE_RENDERER === 'software') return { disable: true, reason: 'software_session', switches: [] }
  if (crashes.disabled && choice !== 'gpu') return { disable: true, reason: 'gpu_crashed', switches: [] }
  const switches: [string, string?][] = [
    ['enable-gpu-rasterization'],
    ['enable-zero-copy'],
    // Hardware video decoding (VA-API) through GL on Linux: playback in Meet, Drive previews and web apps.
    ['enable-features', 'AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,AcceleratedVideoEncoder'],
  ]
  // Chromium's blocklist turns off acceleration for drivers Mesa has long since fixed; the crash fallback above covers
  // the ones that still fail. Only on a GPU the compositor itself uses.
  if (env.WORKSUITE_RENDERER === 'gpu' || choice === 'gpu') switches.push(['ignore-gpu-blocklist'])
  return { disable: false, reason: null, switches }
}

// ---------- tool output parsers ----------
/** `vainfo` → driver line and the profiles with decode (VLD) and encode (EncSlice*) entrypoints. */
export function parseVainfo(text: string): GraphicsState['vaapi'] {
  const driver = text.match(/Driver version:\s*(.+)$/m)?.[1].trim() ?? null
  const decode = new Set<string>(), encode = new Set<string>()
  for (const m of text.matchAll(/^\s*VAProfile(\w+?)\s*:\s*VAEntrypoint(\w+)/gm)) {
    if (m[1] === 'None') continue
    if (m[2] === 'VLD') decode.add(m[1])
    else if (/^EncSlice/.test(m[2])) encode.add(m[1])
  }
  return { available: !!driver && decode.size + encode.size > 0, driver, decode: [...decode], encode: [...encode] }
}

/** `vulkaninfo --summary` → API version and devices (llvmpipe shows as a CPU device). */
export function parseVulkanSummary(text: string): GraphicsState['vulkan'] {
  const devices: GraphicsState['vulkan']['devices'] = []
  let api: string | null = null
  for (const block of text.split(/^GPU\d+:\s*$/m).slice(1)) {
    const f = (k: string) => block.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'm'))?.[1].trim() ?? null
    const name = f('deviceName')
    if (!name) continue
    api ??= f('apiVersion')?.replace(/\s*\(.*\)$/, '') ?? null
    devices.push({ name, type: (f('deviceType') ?? '').replace(/^PHYSICAL_DEVICE_TYPE_/, '').toLowerCase(), driver: [f('driverName'), f('driverInfo')].filter(Boolean).join(' ') || null })
  }
  return { available: devices.length > 0, api_version: api, devices }
}

export interface GraphicsDeps {
  exec: Exec
  root?: string
  env?: NodeJS.ProcessEnv
  /** app.getGPUFeatureStatus() */
  featureStatus: () => Record<string, string>
  /** app.getGPUInfo('complete') (resolves to {} when unavailable) */
  gpuInfo: () => Promise<unknown>
  plan: AccelPlan
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

export async function graphicsState(d: GraphicsDeps): Promise<GraphicsState> {
  const env = d.env ?? process.env
  const gpus: Gpu[] = listDevices(d.root ?? '/').filter((x) => x.kind === 'graphics').map((x) => ({
    name: x.name, vendor: x.vendor, ids: x.ids, driver: x.driver, driver_version: x.driver_version, proprietary: x.driver_proprietary, virtual: !!x.driver && VIRTUAL_DRIVERS.has(x.driver),
  }))
  const [va, vk, info] = await Promise.all([
    d.exec('vainfo', []), d.exec('vulkaninfo', ['--summary']),
    Promise.race([d.gpuInfo().catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 4000))]),
  ])
  const aux = ((info as { auxAttributes?: Record<string, unknown> }).auxAttributes ?? {})
  const dev = ((info as { gpuDevice?: Record<string, unknown>[] }).gpuDevice ?? []).find((g) => g.active) ?? {}
  const renderer = env.WORKSUITE_RENDERER === 'gpu' || env.WORKSUITE_RENDERER === 'software' ? env.WORKSUITE_RENDERER : 'unknown'
  return {
    gpus,
    compositor: { renderer, reason: str(env.WORKSUITE_RENDERER_REASON), choice: readRendererChoice(), fell_back: existsSync(rendererFallbackPath()) },
    apps: {
      accelerated: !d.plan.disable && Object.entries(d.featureStatus()).some(([k, v]) => k === 'gpu_compositing' && v.startsWith('enabled')),
      disabled_reason: d.plan.reason,
      features: d.featureStatus(),
      gl_renderer: str(aux.glRenderer), gl_version: str(aux.glVersion),
      driver_vendor: str(dev.driverVendor) ?? str(aux.driverVendor), driver_version: str(dev.driverVersion) ?? str(aux.driverVersion),
    },
    vaapi: va.code === 0 ? parseVainfo(va.stdout + va.stderr) : { available: false, driver: null, decode: [], encode: [] },
    vulkan: vk.code === 0 ? parseVulkanSummary(vk.stdout) : { available: false, api_version: null, devices: [] },
  }
}

/** Settings › Graphics: the renderer choice (next sign-in), and "try the GPU again" after a fallback. */
export function setRenderer(choice: string): { ok: true } | { ok: false; error: string } {
  if (choice !== 'auto' && choice !== 'gpu' && choice !== 'software') return { ok: false, error: 'invalid_argument' }
  try { writeRendererChoice(choice); return { ok: true } } catch { return { ok: false, error: 'failed' } }
}
export function resetGpuFallback(): { ok: true } | { ok: false; error: string } {
  try {
    for (const p of [rendererFallbackPath(), gpuCrashPath()]) rmSync(p, { force: true })
    return { ok: true }
  } catch { return { ok: false, error: 'failed' } }
}
