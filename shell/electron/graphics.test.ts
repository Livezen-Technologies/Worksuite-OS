// Hardware acceleration (#16): the Electron plan (GPU switches or software), the GPU-crash fallback, the renderer
// choice file wlr-env reads, and the vainfo / vulkaninfo parsers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CRASH_WINDOW_MS, accelerationPlan, graphicsState, gpuCrashPath, noteGpuCrash, parseCrashLog, parseGraphicsConf, parseVainfo, parseVulkanSummary,
  readCrashLog, readRendererChoice, recordCrash, rendererFallbackPath, resetGpuFallback, setRenderer,
} from './graphics'

const VAINFO = `Trying display: drm
libva info: VA-API version 1.22.0
vainfo: VA-API version: 1.22 (libva 2.22.0)
vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 25.2.3 ()
vainfo: Supported profile and entrypoints
      VAProfileNone                   :	VAEntrypointVideoProc
      VAProfileH264Main               :	VAEntrypointVLD
      VAProfileH264Main               :	VAEntrypointEncSliceLP
      VAProfileHEVCMain               :	VAEntrypointVLD
      VAProfileAV1Profile0            :	VAEntrypointVLD
`
const VULKAN = `==========
VULKANINFO
==========

Devices:
========
GPU0:
	apiVersion         = 1.4.305
	driverVersion      = 25.0.7
	deviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
	deviceName         = Intel(R) Iris(R) Xe Graphics (ADL GT2)
	driverName         = Intel open-source Mesa driver
	driverInfo         = Mesa 25.0.7-2
GPU1:
	apiVersion         = 1.4.305 (4210993)
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 19.1.7, 256 bits)
	driverName         = llvmpipe
`

describe('parsers', () => {
  it('vainfo: driver, decode and encode profiles', () => {
    expect(parseVainfo(VAINFO)).toEqual({ available: true, driver: 'Intel iHD driver for Intel(R) Gen Graphics - 25.2.3 ()', decode: ['H264Main', 'HEVCMain', 'AV1Profile0'], encode: ['H264Main'] })
    expect(parseVainfo('libva error: vaGetDriverNames() failed with unknown libva error\n').available).toBe(false)
  })
  it('vulkaninfo --summary: devices and API version', () => {
    expect(parseVulkanSummary(VULKAN)).toEqual({ available: true, api_version: '1.4.305', devices: [
      { name: 'Intel(R) Iris(R) Xe Graphics (ADL GT2)', type: 'integrated_gpu', driver: 'Intel open-source Mesa driver Mesa 25.0.7-2' },
      { name: 'llvmpipe (LLVM 19.1.7, 256 bits)', type: 'cpu', driver: 'llvmpipe' },
    ] })
    expect(parseVulkanSummary('ERROR: [Loader Message] ...').available).toBe(false)
  })
  it('graphics.conf', () => {
    expect(parseGraphicsConf('# c\nrenderer=software\n')).toBe('software')
    expect(parseGraphicsConf('renderer="gpu"')).toBe('gpu')
    expect(parseGraphicsConf('renderer=fast')).toBe('auto')
    expect(parseGraphicsConf(null)).toBe('auto')
  })
})

describe('acceleration plan', () => {
  const ok = { crashes: [], disabled: false }
  it('GPU session: rasterization, zero-copy, VA-API decode and no blocklist', () => {
    const p = accelerationPlan({ WORKSUITE_RENDERER: 'gpu' }, ok, 'auto')
    expect(p.disable).toBe(false)
    expect(p.switches.map(([k]) => k)).toEqual(['enable-gpu-rasterization', 'enable-zero-copy', 'enable-features', 'ignore-gpu-blocklist'])
    expect(p.switches.find(([k]) => k === 'enable-features')?.[1]).toContain('AcceleratedVideoDecodeLinuxGL')
  })
  it('unknown session keeps Chromium’s blocklist', () => {
    expect(accelerationPlan({}, ok, 'auto').switches.map(([k]) => k)).not.toContain('ignore-gpu-blocklist')
  })
  it('software when the compositor is in software, chosen, or after GPU crashes (unless the GPU is forced)', () => {
    expect(accelerationPlan({ WORKSUITE_RENDERER: 'software' }, ok, 'auto')).toEqual({ disable: true, reason: 'software_session', switches: [] })
    expect(accelerationPlan({ WORKSUITE_RENDERER: 'gpu' }, ok, 'software')).toMatchObject({ disable: true, reason: 'choice' })
    expect(accelerationPlan({ WORKSUITE_RENDERER: 'gpu' }, { crashes: [1, 2, 3], disabled: true }, 'auto')).toMatchObject({ disable: true, reason: 'gpu_crashed' })
    expect(accelerationPlan({ WORKSUITE_RENDERER: 'gpu' }, { crashes: [1, 2, 3], disabled: true }, 'gpu').disable).toBe(false)
  })
  it('three GPU crashes within ten minutes turn acceleration off; spread-out ones do not', () => {
    let log = parseCrashLog('garbage')
    log = recordCrash(log, 0); log = recordCrash(log, CRASH_WINDOW_MS + 1); log = recordCrash(log, 2 * CRASH_WINDOW_MS + 2)
    expect(log.disabled).toBe(false)
    log = recordCrash(log, 2 * CRASH_WINDOW_MS + 3); log = recordCrash(log, 2 * CRASH_WINDOW_MS + 4)
    expect(log).toEqual({ crashes: [2 * CRASH_WINDOW_MS + 2, 2 * CRASH_WINDOW_MS + 3, 2 * CRASH_WINDOW_MS + 4], disabled: true })
  })
})

describe('state files and graphicsState', () => {
  let dir: string
  const saved = { c: process.env.XDG_CONFIG_HOME, s: process.env.XDG_STATE_HOME }
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ws-gfx-'))
    process.env.XDG_CONFIG_HOME = path.join(dir, 'config'); process.env.XDG_STATE_HOME = path.join(dir, 'state')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of [['XDG_CONFIG_HOME', saved.c], ['XDG_STATE_HOME', saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  it('writes the renderer choice in the format wlr-env reads, and resets fallbacks', () => {
    expect(setRenderer('fast')).toEqual({ ok: false, error: 'invalid_argument' })
    expect(setRenderer('software')).toEqual({ ok: true })
    expect(readFileSync(path.join(dir, 'config/worksuite/graphics.conf'), 'utf8')).toMatch(/^renderer=software$/m)
    expect(readRendererChoice()).toBe('software')
    noteGpuCrash(1); noteGpuCrash(2); noteGpuCrash(3)
    expect(readCrashLog().disabled).toBe(true)
    mkdirSync(path.dirname(rendererFallbackPath()), { recursive: true }); writeFileSync(rendererFallbackPath(), 'software\n')
    expect(resetGpuFallback()).toEqual({ ok: true })
    expect(readCrashLog()).toEqual({ crashes: [], disabled: false })
    expect(() => readFileSync(gpuCrashPath())).toThrow()
  })

  it('reports GPUs (virtual adapters marked), compositor renderer, Chromium status and APIs', async () => {
    const root = path.join(dir, 'root')
    const d = path.join(root, 'sys/bus/pci/devices/0000:00:02.0')
    mkdirSync(d, { recursive: true })
    for (const [k, v] of Object.entries({ class: '0x030000', vendor: '0x1af4', device: '0x1050' })) writeFileSync(path.join(d, k), v)
    mkdirSync(path.join(root, 'drivers/virtio_gpu'), { recursive: true }); symlinkSync(path.join(root, 'drivers/virtio_gpu'), path.join(d, 'driver'))
    const exec = async (cmd: string) => cmd === 'vainfo' ? { code: 1, stdout: '', stderr: 'failed' } : { code: 0, stdout: VULKAN, stderr: '' }
    const g = await graphicsState({
      exec, root, env: { WORKSUITE_RENDERER: 'software', WORKSUITE_RENDERER_REASON: 'virtual_gpu' },
      featureStatus: () => ({ gpu_compositing: 'disabled_software', webgl: 'unavailable_software' }),
      gpuInfo: async () => ({ auxAttributes: { glRenderer: 'llvmpipe', glVersion: '4.5 (Core Profile) Mesa 25.0.7' } }),
      plan: accelerationPlan({ WORKSUITE_RENDERER: 'software' }, { crashes: [], disabled: false }, 'auto'),
    })
    expect(g.gpus).toEqual([{ name: 'Graphics', vendor: null, ids: '1af4:1050', driver: 'virtio_gpu', driver_version: null, proprietary: null, virtual: true }])
    expect(g.compositor).toEqual({ renderer: 'software', reason: 'virtual_gpu', choice: 'auto', fell_back: false })
    expect(g.apps).toMatchObject({ accelerated: false, disabled_reason: 'software_session', gl_renderer: 'llvmpipe' })
    expect(g.vaapi.available).toBe(false)
    expect(g.vulkan.devices).toHaveLength(2)
  })
})
