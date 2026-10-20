// Remote support capture window (issue #19): preload of a hidden window that the main process
// (remoteSession.ts) opens only after the person at the device allowed the session. It captures the screen through
// getDisplayMedia → the ScreenCast portal (PipeWire; the portal's chooser asks which screen, every time), sends it over
// WebRTC (DTLS-SRTP), and passes data-channel messages (input, chat) to the main process, which decides what to apply.
// Signalling goes through the main process, which holds the device credential; this page never sees it.
import { ipcRenderer } from 'electron'

let stream: MediaStream | null = null
let pc: RTCPeerConnection | null = null
let dc: RTCDataChannel | null = null
let ice: RTCIceServer[] = []

const out = (m: unknown) => ipcRenderer.send('rs:signal-out', m)

async function connect() {
  pc?.close()
  const p = new RTCPeerConnection({ iceServers: ice })
  pc = p
  for (const t of stream!.getTracks()) p.addTrack(t, stream!)
  dc = p.createDataChannel('control', { ordered: true })
  dc.onmessage = (e) => {
    let m: unknown
    try { m = JSON.parse(String(e.data)) } catch { return }
    if (m && typeof m === 'object' && (m as { t?: unknown }).t === 'chat') ipcRenderer.send('rs:chat-in', String((m as { text?: unknown }).text ?? '').slice(0, 500))
    else ipcRenderer.send('rs:input', m)
  }
  p.onicecandidate = (e) => { if (e.candidate) out({ type: 'ice', candidate: e.candidate.toJSON() }) }
  // Temporary network loss: a fresh offer once the connection has failed (the viewer answers it).
  p.onconnectionstatechange = () => { ipcRenderer.send('rs:conn', p.connectionState); if (p.connectionState === 'failed' && pc === p) setTimeout(() => { if (pc === p) void connect() }, 2000) }
  const offer = await p.createOffer()
  await p.setLocalDescription(offer)
  out({ type: 'offer', sdp: p.localDescription!.sdp })
}

ipcRenderer.on('rs:start', async (_e, cfg: { iceServers: RTCIceServer[]; maxFps: number }) => {
  ice = Array.isArray(cfg?.iceServers) ? cfg.iceServers : []
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: cfg?.maxFps ?? 30, max: 30 } }, audio: false })
  } catch (e) {
    ipcRenderer.send('rs:ended', `capture_refused: ${(e as Error).message}`)
    return
  }
  const track = stream.getVideoTracks()[0]
  const s = track.getSettings()
  ipcRenderer.send('rs:screen', { w: s.width ?? 1920, h: s.height ?? 1080 })
  // Stopped from outside (Stop sharing, Super+Shift+Esc, the portal): the session ends.
  track.onended = () => ipcRenderer.send('rs:ended', 'capture_stopped')
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
