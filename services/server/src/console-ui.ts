// Admin console UI: one static page, no build step, no third-party code. All data is rendered with textContent
// (never innerHTML), and the page runs under a CSP with script-src 'self'.

const LOGO = `<svg viewBox="0 0 30 38" width="22" height="28" aria-hidden="true"><rect x="10" y="0" width="20" height="20" fill="#0A6CFF"/><rect x="0" y="10" width="10" height="10" fill="#00DAF2"/><rect x="10" y="10" width="10" height="10" fill="#0B2A66"/><rect x="10" y="20" width="10" height="10" fill="#00DAF2"/><rect x="0" y="33" width="30" height="5" rx="2.5" fill="#E2E8F0"/></svg>`;

export const APP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkSuite Admin</title><link rel="stylesheet" href="/admin/app.css"></head><body>
<div id="login" class="login" hidden><form id="login-form" class="card login-card" novalidate>
<div class="brand">${LOGO}<span>WorkSuite Admin</span></div>
<p id="login-error" class="error" role="alert" hidden></p>
<label>Email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button class="primary" type="submit">Sign in</button></form></div>
<div id="app" class="shell" hidden>
<nav class="side" aria-label="Sections"><div class="brand">${LOGO}<span>WorkSuite</span></div>
<a href="#overview">Overview</a><a href="#devices">Devices</a><a href="#wipes">Wipe requests</a><a href="#users">Users</a>
<a href="#enroll">Enrollment</a><a href="#policy">Policy</a><a href="#apps">App catalog</a><a href="#releases">Releases</a><a href="#activity">Activity</a>
<div class="me"><span id="me-name"></span><span id="me-org" class="muted"></span><button id="logout" class="link">Sign out</button></div></nav>
<main id="main" tabindex="-1"></main></div>
<div id="toast" class="toast" role="status" hidden></div>
<script src="/admin/app.js"></script></body></html>`;

export const APP_CSS = `
:root{--bg:#f5f7fb;--panel:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#0A6CFF;--accent-text:#fff;--side:#001842;--side-text:#cbd5e1;
--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--chip:#eef2ff;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--panel:#111a2e;--text:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--side:#050b18;--side-text:#94a3b8;
--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--chip:#1e293b;color-scheme:dark}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--text)}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}.login-card{width:min(380px,100%);display:grid;gap:14px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px}
.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
.side{background:var(--side);color:var(--side-text);padding:20px 12px;display:flex;flex-direction:column;gap:2px}
.side .brand{color:#fff;padding:0 8px 18px}.side a{color:inherit;text-decoration:none;padding:8px 10px;border-radius:8px}
.side a:hover{background:#ffffff12}.side a[aria-current=page]{background:var(--accent);color:#fff}
.me{margin-top:auto;display:grid;gap:2px;padding:12px 8px 0;border-top:1px solid #ffffff1a;font-size:13px}
.me .link{color:#93c5fd;justify-self:start;padding:4px 0}
main{padding:28px;max-width:1200px;width:100%;outline:none}h1{font-size:22px;margin:0 0 18px}h2{font-size:16px;margin:24px 0 10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}.stat b{display:block;font-size:28px}
.muted{color:var(--muted)}.error{color:var(--bad);margin:0}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:0}tr.click{cursor:pointer}tr.click:hover td{background:var(--chip)}
.table-wrap{overflow-x:auto}.table-wrap table{min-width:620px}td b{white-space:nowrap}
label{display:grid;gap:6px;font-size:14px;color:var(--muted)}
input,select,textarea{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
textarea{min-height:70px}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:8px 14px;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-text);border-color:transparent;font-weight:600}
button.danger{color:var(--bad);border-color:currentColor}button.link{border:0;background:none;padding:0;color:var(--accent)}
button:disabled{opacity:.5;cursor:default}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.form{display:grid;gap:14px;max-width:560px}
.chip{display:inline-block;padding:2px 9px;border-radius:99px;background:var(--chip);font-size:12px}
.secret{font-family:ui-monospace,monospace;word-break:break-all;background:var(--chip);padding:10px;border-radius:8px}
.toast{position:fixed;bottom:20px;right:20px;background:var(--text);color:var(--bg);padding:10px 16px;border-radius:10px;max-width:min(420px,90vw)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0}dt{color:var(--muted)}dd{margin:0}
.grow{flex:1;margin:0}.modal-back{position:fixed;inset:0;background:rgba(2,6,16,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}
.wipe-dlg{width:min(520px,100%);border-radius:20px;background:#0F2350;color:#E8EEFA;border:1px solid rgba(255,138,122,.5);box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden}
.wipe-dlg .muted{color:#8FA3C8}.wipe-head{padding:24px 24px 14px;display:flex;gap:16px}.wipe-head h2{margin:0 0 6px;font-size:20px}
.wipe-head p{margin:0;font-size:14px;color:#C9D6EE;line-height:1.5}.wipe-head p.muted{color:#8FA3C8;margin-top:4px}
.wipe-icon{flex:none;width:48px;height:48px;border-radius:14px;background:rgba(217,69,43,.18) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23FF8A7A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'/%3E%3C/svg%3E") center no-repeat}
.wipe-body{padding:6px 24px 18px;display:grid;gap:14px}.wipe-body .field{display:grid;gap:6px}.wipe-body label,.wipe-body .lbl{font-size:12px;color:#C9D6EE;display:block}
.wipe-body strong{color:#fff}.wipe-dlg input,.wipe-dlg textarea{height:44px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(4,10,26,.6);color:#fff}
.wipe-dlg textarea{height:auto;min-height:0;padding:10px 14px;resize:vertical}.wipe-dlg .mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:14px}
.wipe-dlg input.good{border-color:#5FD39A}.wipe-dlg input.bad{border-color:#FF8A7A}
.seg{display:flex;gap:8px;flex-wrap:wrap}.seg button{background:rgba(4,10,26,.6);color:#C9D6EE;border:1px solid rgba(127,178,255,.25);border-radius:10px;font-size:13px}
.seg button[aria-checked=true]{border-color:#FF8A7A;color:#fff;background:rgba(217,69,43,.18)}
.wipe-foot{padding:14px 18px;background:rgba(4,10,26,.35);border-top:1px solid rgba(127,178,255,.12);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.wipe-foot .muted{font-size:12px}.wipe-foot button{padding:10px 18px;border-radius:10px;background:transparent;color:#E8EEFA;border:1px solid rgba(127,178,255,.25);font-weight:500}
.wipe-foot button.erase{background:#D9452B;border-color:transparent;color:#fff;font-weight:600}.wipe-foot button.erase:disabled{opacity:1;background:rgba(217,69,43,.3);color:rgba(255,255,255,.5)}
@media (max-width:760px){.shell{grid-template-columns:1fr}.side{flex-direction:row;flex-wrap:wrap;padding:10px}.side .brand{width:100%;padding-bottom:8px}
.me{width:100%;border:0}main{padding:16px}}
`;

export const APP_JS = String.raw`'use strict';
const $ = (s) => document.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
async function api(method, path, body) {
  const res = await fetch('/admin/api/' + path, { method, credentials: 'same-origin', headers: { 'x-ws-admin': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Please sign in again.'); }
  const text = await res.text(); const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  return data;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000); }
const when = (ms) => ms ? new Date(ms).toLocaleString() : '—';
const ago = (ms) => { if (!ms) return 'never'; const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: head.length, class: 'muted' }, 'Nothing here yet.')))));
async function act(fn, ok) { try { await fn(); if (ok) toast(ok); route(); } catch (e) { toast(e.message); } }

function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#login-form').email.focus(); }
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target; const err = $('#login-error'); err.hidden = true;
  try { await api('POST', 'login', { email: f.email.value, password: f.password.value }); f.password.value = ''; start(); }
  catch (x) { err.textContent = x.message; err.hidden = false; }
});
$('#logout').addEventListener('click', async () => { await api('POST', 'logout').catch(() => {}); showLogin(); });

/** G16 / WSOS-WIPE-001: the erase dialog. Its button stays disabled until the admin password is entered and the device
 *  name is typed exactly; the server checks both again (reauth) and logs the attempt to the audit trail. */
function wipeDialog(o) {
  const prev = document.activeElement;
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const pw = h('input', { id: 'wp-pw', type: 'password', autocomplete: 'current-password' });
  const name = h('input', { id: 'wp-name', class: 'mono', autocomplete: 'off', spellcheck: 'false' });
  let scope = 'full_device';
  const scopeBtns = o.request ? [['full_device', 'Everything (crypto-erase)'], ['worksuite_data', 'WorkSuite data only']].map(([v, l]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === scope), onclick: (e) => { scope = v; for (const b of scopeBtns) b.setAttribute('aria-checked', String(b === e.currentTarget)); body.textContent = text(); } }, l)) : [];
  const reason = o.request ? h('textarea', { id: 'wp-reason', rows: 2, placeholder: 'Shown to the approving administrator' }) : null;
  const text = () => (o.request ? scope : o.scope) === 'full_device'
    ? 'All data, accounts and apps are erased the next time it connects. This can\'t be undone.'
    : 'WorkSuite data, accounts and the device\'s enrollment are removed the next time it connects. This can\'t be undone.';
  const body = h('p', {}, text());
  const btn = h('button', { class: 'erase', disabled: true, onclick: () => {
    const c = { confirm_name: name.value.trim(), password: pw.value };
    pw.value = ''; check();
    o.submit(c, o.request ? { scope, reason: reason.value } : {}).then((ok) => { if (ok) close(); });
  } }, o.label);
  const check = () => {
    const nameOk = name.value.trim() === o.hostname, pwOk = pw.value.length > 0, reasonOk = !reason || reason.value.trim().length >= 5;
    pw.classList.toggle('good', pwOk); name.classList.toggle('good', nameOk); name.classList.toggle('bad', !!name.value && !nameOk);
    btn.disabled = !(nameOk && pwOk && reasonOk);
  };
  pw.oninput = check; name.oninput = check; if (reason) reason.oninput = check;
  const step = (n, label, input) => h('div', { class: 'field' }, h('label', { for: input.id }, n + ' · ', label), input);
  const n = o.request ? 3 : 1;
  const dlg = h('div', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'wp-t', 'aria-describedby': 'wp-d', class: 'wipe-dlg' },
    h('div', { class: 'wipe-head' }, h('span', { class: 'wipe-icon', 'aria-hidden': 'true' }),
      h('div', {}, h('h2', { id: 'wp-t' }, 'Erase ' + o.hostname + '?'), h('div', { id: 'wp-d' }, body, h('p', { class: 'muted' }, o.meta)))),
    h('div', { class: 'wipe-body' },
      o.request ? [h('div', { class: 'field' }, h('span', { class: 'lbl' }, '1 · What to erase'), h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'What to erase' }, scopeBtns)),
        step(2, 'Reason (sent to the audit trail)', reason)] : null,
      step(n, 'Re-enter your admin password', pw),
      step(n + 1, ['Type the device name ', h('strong', { class: 'mono' }, o.hostname), ' to confirm'], name)),
    h('div', { class: 'wipe-foot' }, h('span', { class: 'muted' }, o.note),
      h('div', { class: 'row' }, h('button', { onclick: close }, 'Cancel'), btn)));
  back.append(dlg); document.body.append(back); document.addEventListener('keydown', onKey);
  (reason || pw).focus();
}
async function wipeSubmit(fn, msg) {
  try { const r = await fn(); toast(msg(r)); route(); return true; } catch (e) { toast(e.message); return false; }
}
const views = {
  async overview() {
    const o = await api('GET', 'overview');
    const stat = (label, n, cls) => h('div', { class: 'card stat' }, h('b', { class: cls }, n), label);
    return [h('h1', {}, 'Overview'), h('div', { class: 'grid' },
      stat('Devices', o.devices), stat('Seen in the last 24 h', o.devices_seen_24h), stat('Active users', o.users),
      stat('Wipes awaiting approval', o.pending_wipes, o.pending_wipes ? 'warn' : ''), stat('Failed updates (24 h)', o.failed_updates_24h, o.failed_updates_24h ? 'bad' : ''),
      stat('Policy version', o.policy_version))];
  },
  async devices() {
    const { items } = await api('GET', 'devices');
    return [h('h1', {}, 'Devices'), table(['Device', 'OS', 'Policy', 'Encrypted', 'Last seen', 'Status'], items.map((d) =>
      h('tr', { class: 'click', tabindex: 0, onclick: () => { location.hash = 'device/' + d.id; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = 'device/' + d.id; } },
        h('td', {}, h('b', {}, d.hostname || d.id), h('div', { class: 'muted' }, d.arch)), h('td', {}, d.os_version || '—'), h('td', {}, d.policy_version || '—'),
        h('td', {}, d.encrypted === null ? '—' : d.encrypted ? h('span', { class: 'ok' }, 'Yes') : h('span', { class: 'bad' }, 'No')),
        h('td', {}, ago(d.last_seen)), h('td', {}, d.wiped_at ? h('span', { class: 'chip bad' }, 'Wiped') : d.revoked ? h('span', { class: 'chip bad' }, 'Revoked') : d.pending ? h('span', { class: 'chip' }, d.pending + ' pending') : h('span', { class: 'chip' }, 'Managed')))))];
  },
  async device(id) {
    const d = await api('GET', 'devices/' + encodeURIComponent(id));
    const hb = d.heartbeat || {};
    const send = (command, args) => act(() => api('POST', 'devices/' + id + '/commands', { command, args }), command + ' sent. It runs at the next check-in.');
    const wipeReason = h('textarea', { 'aria-label': 'Reason for the wipe', placeholder: 'Reason (shown to the approving administrator)' });
    const wipeScope = h('select', { 'aria-label': 'Wipe scope' }, h('option', { value: 'worksuite_data' }, 'WorkSuite data only'), h('option', { value: 'full_device' }, 'Full device (crypto-erase)'));
    return [h('p', {}, h('a', { href: '#devices' }, '← Devices')), h('h1', {}, d.hostname || d.id),
      h('div', { class: 'card' }, h('dl', {},
        h('dt', {}, 'Device ID'), h('dd', {}, d.id), h('dt', {}, 'Architecture'), h('dd', {}, d.arch), h('dt', {}, 'Key'), h('dd', {}, d.tpm_backed ? 'TPM-backed' : 'Software'),
        h('dt', {}, 'Enrolled'), h('dd', {}, when(d.enrolled_at)), h('dt', {}, 'Last seen'), h('dd', {}, ago(d.last_seen)),
        h('dt', {}, 'OS / shell / kernel'), h('dd', {}, [hb.os_version, hb.shell_version, hb.kernel_version].map((x) => x || '—').join(' / ')),
        h('dt', {}, 'Policy version'), h('dd', {}, hb.policy_version || '—'), h('dt', {}, 'Update status'), h('dd', {}, hb.update_status || '—'),
        h('dt', {}, 'Inventory'), h('dd', {}, d.inventory ? d.inventory.software_count + ' packages, ' + ago(d.inventory.at) : 'not yet received'),
        h('dt', {}, 'Break-glass password'), h('dd', {}, d.break_glass_escrowed ? 'Escrowed' : 'Not escrowed'),
        h('dt', {}, 'Ownership'), h('dd', {}, d.ownership === 'personal' ? 'Personal' : 'Corporate'),
        h('dt', {}, 'Status'), h('dd', {}, d.wiped_at ? h('span', { class: 'bad' }, 'Wiped ' + when(d.wiped_at) + ' (must enroll again)') : d.revoked ? h('span', { class: 'bad' }, 'Revoked') : 'Managed'))),
      d.revoked ? null : [h('h2', {}, 'Actions'), h('div', { class: 'row' },
        h('button', { onclick: () => send('RequestLock') }, 'Lock screen'), h('button', { onclick: () => send('RefreshPolicy') }, 'Refresh policy'),
        h('button', { onclick: () => send('ScheduleUpdate') }, 'Install updates'), h('button', { onclick: () => send('RebootDuringWindow') }, 'Restart in maintenance window'),
        h('button', { onclick: () => send('CollectApprovedDiagnostics', { bundle_profile: 'basic' }) }, 'Collect diagnostics'),
        h('button', { class: 'danger', onclick: () => { if (confirm('Revoke this device? It stops receiving policy and its credential stops working.')) act(() => api('POST', 'devices/' + id + '/revoke'), 'Device revoked.'); } }, 'Revoke')),
      h('h2', {}, 'Erase'), h('div', { class: 'card row' }, h('p', { class: 'muted grow' }, 'Requires the desktop.devices.wipe permission. A second administrator must approve the request before the device receives it, unless policy waives this for personal devices.'),
        h('button', { class: 'danger', onclick: () => wipeDialog({ request: true, hostname: d.hostname, label: 'Erase device', meta: 'Last seen ' + ago(d.last_seen) + ' · ' + (d.ownership === 'personal' ? 'personal' : 'corporate') + ' device.', note: 'Logged to the audit trail',
          submit: (c, x) => wipeSubmit(() => api('POST', 'wipes', { device_id: id, ...x, ...c }), (r) => r.waived_second_approver ? 'Erase sent. It runs the next time the device connects.' : 'Erase requested. Another administrator must approve it.') }) }, 'Erase device…'))],
      h('h2', {}, 'Commands'), table(['Command', 'Issued', 'State'], d.commands.map((c) => h('tr', {}, h('td', {}, c.command), h('td', {}, new Date(c.issued_at).toLocaleString()),
        h('td', {}, h('span', { class: c.state === 'completed' ? 'ok' : c.state === 'failed' || c.state === 'rejected' ? 'bad' : '' }, c.state + (c.reason ? ' (' + c.reason + ')' : '')))))),
      h('h2', {}, 'Update results'), table(['Release', 'Result', 'When'], d.updates.map((u) => h('tr', {}, h('td', {}, u.release_id), h('td', { class: u.result === 'success' ? 'ok' : 'bad' }, u.result), h('td', {}, when(u.at)))))];
  },
  async wipes() {
    const { items } = await api('GET', 'wipes');
    return [h('h1', {}, 'Wipe requests'), table(['Device', 'Scope', 'Reason', 'Requested', 'Decision'], items.map((w) => h('tr', {},
      h('td', {}, w.hostname), h('td', {}, w.scope === 'full_device' ? 'Full device' : 'WorkSuite data'), h('td', {}, w.reason),
      h('td', {}, w.requested_by + ', ' + when(w.requested_at)),
      h('td', {}, w.cancelled ? 'Cancelled' : w.approved_by ? 'Approved by ' + w.approved_by + (w.result ? ' · device reported ' + w.result + ' ' + when(w.result_at) : '') : w.mine
        ? h('button', { onclick: () => act(() => api('POST', 'wipes/' + w.id + '/cancel'), 'Request cancelled.') }, 'Cancel')
        : h('div', { class: 'row' },
          h('button', { class: 'danger', onclick: () => wipeDialog({ hostname: w.hostname, scope: w.scope, label: 'Approve erase', meta: 'Requested by ' + w.requested_by + ': “' + w.reason + '”', note: 'Logged to the audit trail',
            submit: (c) => wipeSubmit(() => api('POST', 'wipes/' + w.id + '/approve', c), () => 'Erase approved and sent.') }) }, 'Approve…'),
          h('button', { onclick: () => act(() => api('POST', 'wipes/' + w.id + '/cancel'), 'Request cancelled.') }, 'Reject'))))))];
  },
  async users() {
    const { items } = await api('GET', 'users');
    const f = h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault(); act(() => api('POST', 'users', { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value }), 'User added.'); } },
      h('div', { class: 'row' }, h('label', {}, 'Name', h('input', { name: 'name', required: true })), h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true }))),
      h('div', { class: 'row' }, h('label', {}, 'Initial password', h('input', { name: 'password', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' })),
        h('label', {}, 'Role', h('select', { name: 'role' }, h('option', { value: 'user' }, 'User'), h('option', { value: 'admin' }, 'Administrator')))),
      h('div', {}, h('button', { class: 'primary' }, 'Add user')));
    return [h('h1', {}, 'Users'), table(['Name', 'Email', 'Role', ''], items.map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role === 'admin' ? 'Administrator' : 'User'),
      h('td', {}, u.disabled ? h('button', { onclick: () => act(() => api('POST', 'users/' + u.id + '/enable'), 'User enabled.') }, 'Enable')
        : h('button', { class: 'danger', onclick: () => { if (confirm('Disable ' + u.name + '? Their sessions end immediately.')) act(() => api('POST', 'users/' + u.id + '/disable'), 'User disabled.'); } }, 'Disable'))))),
      h('h2', {}, 'Add a user'), f];
  },
  async enroll() {
    const out = h('div');
    const f = h('form', { class: 'card form', onsubmit: async (e) => { e.preventDefault(); try {
      const t = await api('POST', 'enrollment-tokens', { hours: Number(f.hours.value), uses: Number(f.uses.value) });
      out.replaceChildren(h('div', { class: 'card form' }, h('b', {}, 'Enrollment token'), h('p', { class: 'muted' }, 'Shown once. Valid until ' + new Date(t.expires_at).toLocaleString() + ' for ' + t.uses + ' device(s).'),
        h('div', { class: 'secret' }, t.token), h('div', {}, h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(t.token).then(() => toast('Copied.')) }, 'Copy'))));
    } catch (x) { toast(x.message); } } },
      h('p', { class: 'muted' }, 'On a WorkSuite OS device: first-run setup → "Managed by my organization", or Settings → About this device → Enroll. Enter this server\'s address and the token.'),
      h('div', { class: 'row' }, h('label', {}, 'Valid for (hours)', h('input', { name: 'hours', type: 'number', min: 1, max: 720, value: 24 })), h('label', {}, 'Devices', h('input', { name: 'uses', type: 'number', min: 1, max: 1000, value: 1 }))),
      h('div', {}, h('button', { class: 'primary' }, 'Create token')));
    return [h('h1', {}, 'Enrollment'), f, out];
  },
  async policy() {
    const { version, policy: p } = await api('GET', 'policy');
    const sel = (name, opts) => h('select', { name }, h('option', { value: '' }, 'Not set'), opts.map(([v, l]) => h('option', { value: v, selected: p[name] === v }, l)));
    const f = h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault();
      const num = (n) => f[n].value === '' ? null : Number(f[n].value);
      const list = (n) => f[n].value.split(/[\s,]+/).filter(Boolean);
      act(() => api('PUT', 'policy', { policy: { update_ring: f.update_ring.value || null, update_mode: f.update_mode.value || null, maintenance_window: f.maintenance_window.value || null,
        usb_storage: f.usb_storage.value || null, bluetooth: f.bluetooth.value === '' ? null : f.bluetooth.value === 'true', lock_timeout_max_s: num('lock_timeout_max_s'),
        offline_access_days: num('offline_access_days'), offline_wipe_days: num('offline_wipe_days'),
        login_failures_max: num('login_failures_max'), login_lockout_s: num('login_lockout_s'), update_mirror: f.update_mirror.value || null,
        app_allowlist: list('app_allowlist'), approved_remotes: list('approved_remotes') } }).then((r) => toast('Policy version ' + r.version + ' saved and signed; ' + r.devices_notified + ' device(s) notified.')));
    } },
      h('div', { class: 'row' }, h('label', {}, 'Update ring', sel('update_ring', [['stable', 'Stable'], ['pilot', 'Pilot'], ['development', 'Development']])),
        h('label', {}, 'Update mode', sel('update_mode', [['automatic', 'Automatic'], ['notify', 'Notify'], ['manual', 'Manual']])),
        h('label', {}, 'Maintenance window', h('input', { name: 'maintenance_window', placeholder: '02:00-04:00', value: p.maintenance_window || '' }))),
      h('div', { class: 'row' }, h('label', {}, 'USB storage', sel('usb_storage', [['allow', 'Allow'], ['read_only', 'Read-only'], ['block', 'Block']])),
        h('label', {}, 'Bluetooth', sel('bluetooth', [['true', 'Allowed'], ['false', 'Off']])),
        h('label', {}, 'Max screen-lock delay (s)', h('input', { name: 'lock_timeout_max_s', type: 'number', min: 60, value: p.lock_timeout_max_s ?? '' }))),
      h('div', { class: 'row' }, h('label', {}, 'Offline access (days)', h('input', { name: 'offline_access_days', type: 'number', min: 0, value: p.offline_access_days ?? '' })),
        h('label', {}, 'Wipe after offline (days)', h('input', { name: 'offline_wipe_days', type: 'number', min: 1, value: p.offline_wipe_days ?? '' }))),
      h('div', { class: 'row' }, h('label', {}, 'Failed sign-ins before lockout', h('input', { name: 'login_failures_max', type: 'number', min: 3, max: 20, value: p.login_failures_max ?? '' })),
        h('label', {}, 'Lockout duration (s, 0 = until reset)', h('input', { name: 'login_lockout_s', type: 'number', min: 0, value: p.login_lockout_s ?? '' }))),
      h('label', {}, 'Update mirror (https, optional)', h('input', { name: 'update_mirror', value: p.update_mirror || '' })),
      h('label', {}, 'Allowed apps (catalog IDs, one per line)', h('textarea', { name: 'app_allowlist' }, (p.app_allowlist || []).join('\n'))),
      h('label', {}, 'Approved remote-support tools', h('textarea', { name: 'approved_remotes' }, (p.approved_remotes || []).join('\n'))),
      h('div', {}, h('button', { class: 'primary' }, 'Save and sign policy')));
    if (p.bluetooth !== undefined) f.bluetooth.value = String(p.bluetooth);
    return [h('h1', {}, 'Policy'), h('p', { class: 'muted' }, 'Current version ' + version + '. Devices verify the signature before applying it.'), f];
  },
  async apps() {
    const { items } = await api('GET', 'catalog');
    const f = h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault();
      const arches = [f.amd64.checked && 'amd64', f.arm64.checked && 'arm64'].filter(Boolean);
      act(() => api('PUT', 'catalog/' + encodeURIComponent(f.source.value + ':' + f.pkg.value), { source: f.source.value, name: f.name.value, arches, required: f.required.checked, sha256: f.sha256.value || undefined }), 'Catalog updated.'); } },
      h('div', { class: 'row' }, h('label', {}, 'Source', h('select', { name: 'source' }, h('option', { value: 'flatpak' }, 'Flatpak'), h('option', { value: 'apt' }, 'APT'), h('option', { value: 'appimage' }, 'AppImage'))),
        h('label', {}, 'Package / app ID', h('input', { name: 'pkg', required: true, placeholder: 'org.gimp.GIMP' })), h('label', {}, 'Display name', h('input', { name: 'name', required: true }))),
      h('div', { class: 'row' }, h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'amd64', checked: true }), ' amd64')), h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'arm64', checked: true }), ' arm64')),
        h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'required' }), ' Required on every device'))),
      h('label', {}, 'SHA-256 (AppImages only)', h('input', { name: 'sha256' })), h('div', {}, h('button', { class: 'primary' }, 'Add or update')));
    return [h('h1', {}, 'App catalog'), table(['App', 'ID', 'Arch', ''], items.map((i) => h('tr', {}, h('td', {}, i.name, i.required ? h('span', { class: 'chip' }, ' required') : null), h('td', {}, i.id), h('td', {}, i.arches.join(', ')),
      h('td', {}, h('button', { class: 'danger', onclick: () => act(() => api('DELETE', 'catalog/' + encodeURIComponent(i.id)), 'Removed from the catalog.') }, 'Remove'))))),
      h('h2', {}, 'Add an app'), f];
  },
  async releases() {
    const { items } = await api('GET', 'releases');
    return [h('h1', {}, 'Releases'), h('p', { class: 'muted' }, 'Signed OS releases offered to devices. Publishing uses the release signing key: worksuite-server release-publish.'),
      table(['Ring', 'Arch', 'Version', 'Rollout', 'State', 'Flags'], items.map((r) => h('tr', {}, h('td', {}, r.ring), h('td', {}, r.arch), h('td', {}, r.version), h('td', {}, (r.rollout_percent ?? 100) + '%'), h('td', {}, r.state || 'active'),
        h('td', {}, [r.security && 'security', r.mandatory && 'mandatory', r.critical && 'critical'].filter(Boolean).join(', ') || '—'))))];
  },
  async activity() {
    const { items } = await api('GET', 'log');
    return [h('h1', {}, 'Activity'), table(['When', 'Who', 'Action', 'Details'], items.map((l) => h('tr', {}, h('td', {}, when(l.at)), h('td', {}, l.name), h('td', {}, l.action.replace(/_/g, ' ')),
      h('td', { class: 'muted' }, Object.entries(l.detail || {}).map(([k, v]) => k + ': ' + v).join(', ')))))];
  },
};

async function route() {
  const [view, arg] = (location.hash.slice(1) || 'overview').split('/');
  const fn = views[view] || views.overview;
  for (const a of document.querySelectorAll('.side a')) a.toggleAttribute('aria-current', a.getAttribute('href') === '#' + (view === 'device' ? 'devices' : view));
  for (const a of document.querySelectorAll('.side a[aria-current]')) a.setAttribute('aria-current', 'page');
  const main = $('#main');
  try { main.replaceChildren(...[await fn(arg ? decodeURIComponent(arg) : undefined)].flat(Infinity).filter((x) => x != null)); main.focus(); }
  catch (e) { main.replaceChildren(h('h1', {}, 'Something went wrong'), h('p', { class: 'error' }, e.message)); }
}
async function start() {
  try { const me = await api('GET', 'me'); $('#me-name').textContent = me.name; $('#me-org').textContent = me.org_name; } catch { return; }
  $('#login').hidden = true; $('#app').hidden = false; route();
}
window.addEventListener('hashchange', route);
start();
`;
