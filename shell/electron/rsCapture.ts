// Remote support capture window (issue #19): preload of a hidden window that the main process
// (remoteSession.ts) opens only after the person at the device allowed the session. It captures the screen through
// getDisplayMedia → the ScreenCast portal (PipeWire; the portal's chooser asks which screen, every time), sends it over
// WebRTC (DTLS-SRTP), and passes data-channel messages (input, chat, files, clipboard, quality, monitors) to the main
// process, which decides what to apply. Signalling goes through the main process, which holds the device credential;
// this page never sees it. Issue #37: quality presets (track constraints + sender bitrate), monitor switching
// (a new capture replaces the track without renegotiating), paced sending for file transfers, fresh ICE servers.
import { ipcRenderer } from 'electron'
import { downscale, type Quality } from './rsQuality'

let stream: MediaStream | null = null
let pc: RTCPeerConnection | null = null
let dc: RTCDataChannel | null = null
let ice: RTCIceServer[] = []
let quality: Quality | null = null
const queue: string[] = []
const HIGH_WATER = 1024 * 1024
const INPUT = new Set(['pm', 'pb', 'ax', 'k'])

const out = (m: unknown) => ipcRenderer.send('rs:signal-out', m)

/** Sends queued data-channel messages while the channel's buffer is below the high-water mark; acks each one. */
function flush() {
  while (dc?.readyState === 'open' && queue.length && dc.bufferedAmount < HIGH_WATER) {
    dc.send(queue.shift()!)
    ipcRenderer.send('rs:dc-ack')
  }
}

async function applyQuality() {
  const track = stream?.getVideoTracks()[0]
  if (!track || !quality) return
  await track.applyConstraints({ frameRate: { max: quality.fps } }).catch(() => {})
  const s = track.getSettings()
  const sender = pc?.getSenders().find((x) => x.track === track)
  if (!sender) return
  const p = sender.getParameters()
  if (!p.encodings?.length) p.encodings = [{}]
  p.encodings[0].maxBitrate = quality.kbps * 1000
  p.encodings[0].maxFramerate = quality.fps
  p.encodings[0].scaleResolutionDownBy = downscale(s.width ?? 0, s.height ?? 0, quality)
  await sender.setParameters(p).catch(() => {})
}

function watch(track: MediaStreamTrack) {
  const s = track.getSettings()
  ipcRenderer.send('rs:screen', { w: s.width ?? 1920, h: s.height ?? 1080 })
  // Stopped from outside (Stop sharing, Super+Shift+Esc, the portal): the session ends.
  track.onended = () => { if (stream?.getVideoTracks()[0] === track) ipcRenderer.send('rs:ended', 'capture_stopped') }
}

async function connect() {
  pc?.close()
  const p = new RTCPeerConnection({ iceServers: ice })
  pc = p
  for (const t of stream!.getTracks()) p.addTrack(t, stream!)
  dc = p.createDataChannel('control', { ordered: true })
  dc.bufferedAmountLowThreshold = HIGH_WATER / 2
  dc.onbufferedamountlow = flush
  dc.onopen = flush
  dc.onmessage = (e) => {
    let m: unknown
    try { m = JSON.parse(String(e.data)) } catch { return }
    if (!m || typeof m !== 'object') return
    const t = (m as { t?: unknown }).t
    if (t === 'chat') ipcRenderer.send('rs:chat-in', String((m as { text?: unknown }).text ?? '').slice(0, 500))
    else if (typeof t === 'string' && INPUT.has(t)) ipcRenderer.send('rs:input', m)
    else ipcRenderer.send('rs:dc', m)
  }
  p.onicecandidate = (e) => { if (e.candidate) out({ type: 'ice', candidate: e.candidate.toJSON() }) }
  // Temporary network loss: a fresh offer once the connection has failed (the viewer answers it).
  p.onconnectionstatechange = () => {
    ipcRenderer.send('rs:conn', p.connectionState)
    if (p.connectionState === 'connected') void applyQuality()
    if (p.connectionState === 'failed' && pc === p) setTimeout(() => { if (pc === p) void connect() }, 2000)
  }
  const offer = await p.createOffer()
  await p.setLocalDescription(offer)
  out({ type: 'offer', sdp: p.localDescription!.sdp })
}

async function capture(maxFps: number) {
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: maxFps, max: 30 } }, audio: false })
}

ipcRenderer.on('rs:start', async (_e, cfg: { iceServers: RTCIceServer[]; maxFps: number; quality?: Quality }) => {
  ice = Array.isArray(cfg?.iceServers) ? cfg.iceServers : []
  quality = cfg?.quality ?? null
  try {
    stream = await capture(quality?.fps ?? cfg?.maxFps ?? 30)
  } catch (e) {
    ipcRenderer.send('rs:ended', `capture_refused: ${(e as Error).message}`)
    return
  }
  watch(stream.getVideoTracks()[0])
  await connect()
})

ipcRenderer.on('rs:signal-in', async (_e, m: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }) => {
  if (!pc) return
  try {
    if (m.type === 'answer' && m.sdp) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp })
    else if (m.type === 'ice' && m.candidate) await pc.addIceCandidate(m.candidate)
    else if (m.type === 'bye') await connect()           // the viewer reconnects: negotiate again
  } catch { /* a stale answer or candidate after a reconnect */ }
})

ipcRenderer.on('rs:chat-out', (_e, text: string) => { if (dc?.readyState === 'open') dc.send(JSON.stringify({ t: 'chat', text: String(text).slice(0, 500) })) })
ipcRenderer.on('rs:dc-send', (_e, text: string) => { queue.push(String(text)); flush() })
ipcRenderer.on('rs:ice', (_e, list: RTCIceServer[]) => { if (Array.isArray(list)) ice = list })
ipcRenderer.on('rs:quality', (_e, q: Quality) => { quality = q; void applyQuality() })
// Another monitor: the main process chose the source; a new capture replaces the track on the same connection.
ipcRenderer.on('rs:switch', async () => {
  let next: MediaStream
  try { next = await capture(quality?.fps ?? 30) } catch { return }     // refused in the portal: keep the current one
  const old = stream
  stream = next
  const track = next.getVideoTracks()[0]
  watch(track)
  const sender = pc?.getSenders().find((x) => x.track?.kind === 'video')
  await sender?.replaceTrack(track).catch(() => {})
  for (const t of old?.getTracks() ?? []) { t.onended = null; t.stop() }
  await applyQuality()
})
