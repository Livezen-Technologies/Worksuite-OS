// Remote support stream quality presets (issue #37): the viewer picks one, the capture window applies it to the
// screen track (resolution, frame rate) and to the WebRTC sender (bitrate). Shared by remoteSession.ts and rsCapture.ts.
export type QualityPreset = 'low' | 'balanced' | 'high'
export interface Quality { maxWidth: number; maxHeight: number; fps: number; kbps: number }

export const QUALITY: Record<QualityPreset, Quality> = {
  low: { maxWidth: 1280, maxHeight: 720, fps: 10, kbps: 1000 },
  balanced: { maxWidth: 1920, maxHeight: 1080, fps: 20, kbps: 3000 },
  high: { maxWidth: 2560, maxHeight: 1440, fps: 30, kbps: 8000 },
}
export const DEFAULT_QUALITY: QualityPreset = 'balanced'

export const isPreset = (v: unknown): v is QualityPreset => v === 'low' || v === 'balanced' || v === 'high'

/** Scale factor for RTCRtpEncodingParameters.scaleResolutionDownBy so the sent frame fits the preset's box. */
export function downscale(w: number, h: number, q: Quality): number {
  if (!(w > 0 && h > 0)) return 1
  return Math.max(1, w / q.maxWidth, h / q.maxHeight)
}
