// Settings › VPN (boards V1Settings, V2Add, V4Trouble; WSOS-INT-001). Everything comes from os.sysVpn() (NetworkManager
// via the bridge). NetworkManager doesn't report handshakes, traffic or peer keys to the shell, so those places show
// what it does report (interface, type, who set it up) instead of sample values.
import { AnimatedProgress } from '../../components/AnimatedProgress'
import { useState } from 'react'
import { os, type VpnConnection, type VpnState } from '../../lib/os'
import { useSystem } from '../../lib/useSystem'
import { vpnErrorText } from '../../lib/vpn'
import { C, Dialog, Svg, btnGhost, btnPrimary, card, dialogFooter, rowLine } from '../../components/Dk'
import { Empty } from '../Hardware'
import { t } from '../../i18n'
import { BigSwitch, H1, MonoTag, Note, Unavail } from './ui'

export const SHIELD = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'
const kindLabel = (c: VpnConnection) => (c.kind === 'wireguard' ? 'WireGuard' : c.kind === 'openvpn' ? 'OpenVPN' : t('vpn.title'))
/** The connection the page leads with: the organization's, else the connected one, else the first. */
export const primaryVpn = (s: VpnState) => s.connections.find((c) => c.managed) ?? s.connections.find((c) => c.active) ?? s.connections[0] ?? null

type Fail = { uuid: string; name: string; text: string }

export function VpnPanel() {
  const { state, reload } = useSystem(os.sysVpn, 10_000)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [fail, setFail] = useState<Fail | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<VpnConnection | null>(null)
  const [ask, setAsk] = useState<VpnConnection | null>(null)

  const connect = async (c: VpnConnection, on: boolean, creds?: { username: string; password: string }) => {
    if (on && c.needs_credentials && !creds) { setAsk(c); return }
    setBusy(c.uuid); setMsg(null); setFail(null)
    const r = await os.sysVpnConnect(c.uuid, on, creds)
    setBusy(null)
    if (r.available) setMsg(on ? t('vpn.connectedTo', { name: c.name }) : t('vpn.disconnectedFrom', { name: c.name }))
    else { const text = vpnErrorText(r.reason); if (text) setFail({ uuid: c.uuid, name: c.name, text }) }
    void reload()
  }
  const remove = async (c: VpnConnection) => {
    setConfirmRemove(null); setBusy(c.uuid); setFail(null)
    const r = await os.sysVpnRemove(c.uuid)
    setBusy(null)
    setMsg(r.available ? t('vpn.removed') : vpnErrorText(r.reason) || null)
    void reload()
  }

  const s = state?.available ? state.value : null
  const lead = s ? primaryVpn(s) : null
  const others = s ? s.connections.filter((c) => c !== lead) : []
  const failed = fail && s?.connections.find((c) => c.uuid === fail.uuid)

  return <>
    <H1 action={s?.user_vpn_allowed ? <button type="button" onClick={() => setAdding(true)} className={btnPrimary}>{t('vpn.addTunnel')}</button> : undefined}>{t('vpn.title')}</H1>
    {!state ? <Empty title={t('vpn.reading')} /> : !state.available ? <Unavail what={t('vpn.title')} reason={state.reason} /> : !lead ? (
      <Empty title={t('vpn.none')}>{s!.user_vpn_allowed ? t('vpn.importHint2') : t('vpn.blocked')}</Empty>
    ) : <>
      {failed ? <Trouble c={failed} text={fail!.text} busy={busy === failed.uuid} onRetry={() => void connect(failed, true)} onDisconnect={() => void connect(failed, false)} />
        : <LeadCard c={lead} required={s!.vpn_required} busy={busy === lead.uuid} onToggle={(on) => void connect(lead, on)} />}
      <div className={`${card} overflow-hidden`}>
        {[
          { t: t('vpn.opt.required'), d: t('vpn.opt.requiredHint'), v: s!.vpn_required ? t('vpn.opt.setByIt') : t('common.off') },
          { t: t('vpn.opt.own'), d: t('vpn.opt.ownHint'), v: s!.user_vpn_allowed ? t('vpn.opt.allowed') : t('vpn.opt.blocked') },
          { t: t('vpn.opt.keys'), d: t('vpn.opt.keysHint'), v: t('vpn.opt.system') },
        ].map((o) => (
          <div key={o.t} className={`flex items-center gap-3.5 px-[18px] py-3 ${rowLine}`}>
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{o.t}</span><span className="text-xs text-[#8FA3C8]">{o.d}</span></span>
            <span className="text-[13px] text-[#C9D6EE]">{o.v}</span>
          </div>
        ))}
      </div>
      {others.length > 0 && (
        <section aria-labelledby="vpn-others" className="flex flex-col gap-2">
          <h2 id="vpn-others" className="m-0 text-sm font-semibold">{t('vpn.others')}</h2>
          <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
            {others.map((c) => (
              <li key={c.uuid} className={`flex items-center gap-3 px-[18px] py-2.5 ${rowLine}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: c.active ? C.green : '#5E739C' }} />
                <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{c.name}</span><span className="font-mono text-[11px] text-[#8FA3C8]">{[kindLabel(c), c.device, c.active ? t('common.connected') : t('common.off')].filter(Boolean).join(' · ')}</span></span>
                {!c.managed && <button type="button" disabled={busy !== null} onClick={() => setConfirmRemove(c)} className={`${btnGhost} px-3 py-1.5 text-[13px]`} aria-label={t('common.removeName', { name: c.name })}>{t('common.remove')}</button>}
                <BigSwitch label={t('vpn.connectName', { name: c.name })} checked={c.active} disabled={busy !== null} color="#2E9E6A" onChange={(on) => void connect(c, on)} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {lead && !lead.managed && (
        <button type="button" disabled={busy !== null} onClick={() => setConfirmRemove(lead)} className="cursor-pointer self-start text-xs text-[#7FB2FF] hover:text-[#B8D4FF]">{t('common.removeName', { name: lead.name })}</button>
      )}
      {msg && <p role="status" className="m-0 text-[13px] text-[#C9D6EE]">{msg}</p>}
      <Note>{s!.vpn_required ? t('vpn.requiredNote') : t('vpn.importedNote')}</Note>
    </>}
    {adding && <AddTunnel onClose={() => setAdding(false)} onAdded={(text) => { setAdding(false); setMsg(text); void reload() }} />}
    {ask && <VpnCredentials name={ask.name} onCancel={() => setAsk(null)} onSubmit={(creds) => { const c = ask; setAsk(null); void connect(c, true, creds) }} />}
    {confirmRemove && (
      <Dialog alert onClose={() => setConfirmRemove(null)}>
        {(tid) => <>
          <div className="flex flex-col gap-3 px-6 pt-6 pb-4">
            <h2 id={tid} className="m-0 text-[19px] font-bold">{t('vpn.removeTitle')}</h2>
            <p className="m-0 text-sm text-[#C9D6EE]">{t('vpn.removeBody', { name: confirmRemove.name })}</p>
          </div>
          <div className={dialogFooter}>
            <button type="button" onClick={() => setConfirmRemove(null)} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
            <button type="button" onClick={() => void remove(confirmRemove)} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{t('common.remove')}</button>
          </div>
        </>}
      </Dialog>
    )}
  </>
}

/** V1: the main tunnel with its switch, and what NetworkManager reports about it. */
function LeadCard({ c, required, busy, onToggle }: { c: VpnConnection; required: boolean; busy: boolean; onToggle: (on: boolean) => void }) {
  const on = c.active
  const locked = c.managed && on && required
  const stats = [
    [t('vpn.stat.interface'), c.device ?? '—'],
    [t('vpn.stat.type'), kindLabel(c)],
    [t('vpn.stat.setUpBy'), c.managed ? t('vpn.stat.org') : t('vpn.stat.you')],
    [t('vpn.stat.signIn'), c.needs_credentials ? t('vpn.stat.askEach') : t('vpn.stat.keyFile')],
  ]
  return (
    <div className="overflow-hidden rounded-2xl border bg-[rgba(14,32,72,0.7)]" style={{ borderColor: on ? 'rgba(95,211,154,0.45)' : 'rgba(127,178,255,0.14)' }}>
      <div className="flex items-center gap-4 px-5 py-[18px]">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: on ? '#2E9E6A' : 'rgba(127,178,255,0.18)' }}><Svg d={SHIELD} size={24} stroke="#FFFFFF" /></span>
        <span className="flex flex-1 flex-col gap-[3px]">
          <span className="flex items-center gap-2 text-base font-semibold">{c.name}
            {c.managed && <MonoTag bg="rgba(122,79,224,0.2)" color="#B9A0FF"><span className="uppercase">{t('vpn.tag.managed')}</span></MonoTag>}
            <MonoTag bg="rgba(127,178,255,0.14)" color="#C9D6EE"><span className="uppercase">{kindLabel(c)}</span></MonoTag>
          </span>
          <span className="text-[13px]" style={{ color: on ? C.green : C.muted }}>{busy ? (on ? t('common.disconnecting') : t('common.connecting')) : on ? (locked ? t('vpn.status.required') : t('vpn.status.on')) : t('common.off')}</span>
        </span>
        <BigSwitch label={t('vpn.connectName', { name: c.name })} checked={on} disabled={busy || locked} color="#2E9E6A" onChange={onToggle} />
      </div>
      {busy && <AnimatedProgress value={null} label={on ? t('common.disconnecting') : t('common.connecting')} height={3} className="mx-5 mb-3" />}
      {on && (
        <div className="grid grid-cols-4 border-t border-[rgba(127,178,255,0.12)]">
          {stats.map(([k, v], i) => (
            <div key={k} className="flex flex-col gap-[3px] px-5 py-3.5" style={{ borderLeft: i ? '1px solid rgba(127,178,255,0.1)' : 'none' }}>
              <span className="text-[11px] tracking-[0.06em] text-[#8FA3C8] uppercase">{k}</span><span className="font-mono text-sm">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** V4: the last connect failed. Only checks the shell can really make are listed. */
function Trouble({ c, text, busy, onRetry, onDisconnect }: { c: VpnConnection; text: string; busy: boolean; onRetry: () => void; onDisconnect: () => void }) {
  const { state: net } = useSystem(os.sysNetwork)
  const [copied, setCopied] = useState(false)
  const online = net?.available ? net.value.devices.find((d) => d.state === 'connected') ?? null : null
  const checks: { t: string; d: string; ok: boolean | null }[] = [
    { t: t('vpn.chk.internet'), d: !net ? '…' : !net.available ? t('common.unavailable') : online ? `${online.connection ?? online.device} · ${t('vpn.chk.online')}` : t('common.notConnected'), ok: net?.available ? !!online : null },
    { t: t('vpn.chk.config'), d: `${kindLabel(c)} · ${c.managed ? t('vpn.stat.org') : t('vpn.stat.you')}`, ok: true },
    { t: t('vpn.chk.tunnel'), d: c.active && c.device ? c.device : t('vpn.chk.notUp'), ok: c.active },
  ]
  const copy = () => {
    const lines = [`VPN: ${c.name} (${kindLabel(c)})`, `Error: ${text}`, ...checks.map((x) => `${x.t}: ${x.d}`)]
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => setCopied(true)).catch(() => {})
  }
  return <>
    <div className="flex items-center gap-4 rounded-2xl border border-[rgba(255,159,90,0.5)] bg-[rgba(14,32,72,0.7)] px-5 py-[18px]">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[rgba(255,159,90,0.18)]"><Svg d="M12 8v5M12 16.5v.5M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" size={22} stroke="#FFB98A" /></span>
      <span className="flex flex-1 flex-col gap-[3px]"><span className="text-base font-semibold">{t('vpn.trouble.title', { name: c.name })}</span><span role="alert" className="text-[13px] text-[#FFB98A]">{text}</span></span>
      {c.active && <button type="button" disabled={busy} onClick={onDisconnect} className={`${btnGhost} px-4 py-[9px] text-[13px]`}>{t('common.disconnect')}</button>}
    </div>
    <h2 className="m-0 text-sm font-semibold">{t('vpn.trouble.checks')}</h2>
    <div className={`${card} overflow-hidden`}>
      {checks.map((x) => (
        <div key={x.t} className={`flex items-center gap-3.5 px-[18px] py-3 ${rowLine}`}>
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-xs font-bold text-[#0A1A3D]" style={{ background: x.ok === true ? C.green : x.ok === false ? '#FFB98A' : '#5E739C' }} aria-hidden="true">{x.ok === true ? '✓' : x.ok === false ? '!' : '?'}</span>
          <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm">{x.t}</span><span className="font-mono text-[11px] text-[#8FA3C8]">{x.d}</span></span>
        </div>
      ))}
    </div>
    <div className="flex gap-3 rounded-xl border border-[rgba(31,107,255,0.3)] bg-[rgba(31,107,255,0.08)] px-4 py-3.5 text-[13px] leading-[1.5] text-[#C9D6EE]">
      <Svg d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" size={18} stroke="#7FB2FF" />
      <span>{online === null && net?.available ? t('vpn.trouble.offline') : c.managed ? t('vpn.trouble.askIt') : t('vpn.trouble.checkFile')}</span>
    </div>
    <div className="flex gap-2.5">
      <button type="button" disabled={busy} onClick={onRetry} className={btnPrimary}>{busy ? t('common.connecting') : t('vpn.trouble.retry')}</button>
      <button type="button" onClick={copy} className={btnGhost}>{copied ? t('vpn.trouble.copied') : t('vpn.trouble.copy')}</button>
    </div>
  </>
}

/** V2: add a tunnel. Importing a file works today; QR scanning and manual entry have no backend yet and say so. */
function AddTunnel({ onClose, onAdded }: { onClose: () => void; onAdded: (msg: string) => void }) {
  const [tab, setTab] = useState(0)
  const [then, setThen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pick = async (kind: 'wgconf' | 'ovpn') => {
    setBusy(true); setError(null)
    const f = await os.pickFile(kind)
    if (!f.ok) { setBusy(false); const e = vpnErrorText(f.error); if (e) setError(e); return }
    const r = kind === 'wgconf' ? await os.sysVpnImport(f.value.handle) : await os.sysVpnImportOpenvpn(f.value.handle)
    if (!r.ok) { setBusy(false); setError(vpnErrorText(r.error) || null); return }
    const needsCreds = 'needs_credentials' in r.value && r.value.needs_credentials
    if (then && r.value.uuid && !needsCreds) {
      const c = await os.sysVpnConnect(r.value.uuid, true)
      setBusy(false)
      onAdded(c.available ? t('vpn.connectedTo', { name: r.value.name }) : `${t('vpn.added')} ${vpnErrorText(c.reason)}`)
      return
    }
    setBusy(false)
    onAdded(kind === 'wgconf' ? t('vpn.added') : t('vpn.addedOpenvpn'))
  }
  const tabs = [t('vpn.add.file'), t('vpn.add.qr'), t('vpn.add.manual')]
  return (
    <Dialog width={720} onClose={busy ? undefined : onClose}>
      {(tid) => <>
        <div className="flex flex-col gap-3.5 px-6 pt-[22px] pb-3.5">
          <h2 id={tid} className="m-0 text-xl font-bold">{t('vpn.add.title')}</h2>
          <div role="tablist" aria-label={t('vpn.add.title')} className="flex gap-1 self-start rounded-[10px] bg-[rgba(4,10,26,0.5)] p-1">
            {tabs.map((label, i) => (
              <button key={label} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)}
                className={`cursor-pointer rounded-[7px] px-3.5 py-[7px] text-[13px] font-medium ${tab === i ? 'bg-[#1F6BFF] text-white' : 'text-[#E8EEFA] hover:bg-white/[0.06]'}`}>{label}</button>
            ))}
          </div>
        </div>
        {tab === 0 ? (
          <div className="mx-6 mb-5 flex h-[300px] flex-col items-center justify-center gap-2.5 rounded-[14px] border-2 border-dashed border-[rgba(127,178,255,0.3)] text-center">
            <Svg d="M14 3H6v18h12V7zM14 3v4h4M12 11v6M9 14l3-3 3 3" size={40} stroke="#7FB2FF" width={1.6} />
            <span className="text-[15px] font-semibold">{t('vpn.add.fileTitle')}</span>
            <span className="text-[13px] text-[#8FA3C8]">{t('vpn.add.fileHint')}</span>
            <span className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void pick('wgconf')} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{busy ? t('vpn.adding') : t('vpn.import')}</button>
              <button type="button" disabled={busy} onClick={() => void pick('ovpn')} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('vpn.importOpenvpn')}</button>
            </span>
            <span className="font-mono text-[11px] text-[#8FA3C8]">{t('vpn.add.keyNote')}</span>
            {error && <span role="alert" className="max-w-[560px] text-[13px] text-[#FF8A7A]">{error}</span>}
          </div>
        ) : (
          <div className="mx-6 mb-5 flex h-[300px] flex-col items-center justify-center gap-2.5 rounded-[14px] bg-[rgba(4,10,26,0.6)] px-10 text-center">
            <Svg d={tab === 1 ? 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2z' : 'M4 6h16M4 12h16M4 18h10'} size={36} stroke="#5E739C" />
            <span className="text-[15px] font-semibold">{t('vpn.add.notYet')}</span>
            <span className="max-w-[440px] text-[13px] text-[#8FA3C8]">{tab === 1 ? t('vpn.add.qrNo') : t('vpn.add.manualNo')}</span>
          </div>
        )}
        <div className={`${dialogFooter} justify-between`}>
          <label className="flex items-center gap-2 text-[13px] text-[#C9D6EE]"><input type="checkbox" checked={then} onChange={(e) => setThen(e.target.checked)} className="h-4 w-4 accent-[#1F6BFF]" />{t('vpn.add.connectAfter')}</label>
          <button type="button" disabled={busy} onClick={onClose} className={btnGhost}>{t('common.cancel')}</button>
        </div>
      </>}
    </Dialog>
  )
}

function VpnCredentials({ name, onCancel, onSubmit }: { name: string; onCancel: () => void; onSubmit: (c: { username: string; password: string }) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <Dialog onClose={onCancel}>
      {(tid) => <form onSubmit={(e) => { e.preventDefault(); if (username) onSubmit({ username, password }) }}>
        <div className="flex flex-col gap-3 px-6 pt-6 pb-4">
          <h2 id={tid} className="m-0 text-[19px] font-bold">{t('vpn.connectTo', { name })}</h2>
          <label className="flex flex-col gap-1 text-sm">{t('vpn.username')}<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="rounded-md bg-white/10 px-3 py-2" /></label>
          <label className="flex flex-col gap-1 text-sm">{t('greeter.password')}<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-md bg-white/10 px-3 py-2" /></label>
          <p className="m-0 text-xs text-[#8FA3C8]">{t('vpn.notSaved')}</p>
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={onCancel} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
          <button type="submit" disabled={!username} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{t('common.connect')}</button>
        </div>
      </form>}
    </Dialog>
  )
}
