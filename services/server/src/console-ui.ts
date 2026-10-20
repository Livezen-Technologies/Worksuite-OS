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
<a href="#overview">Overview</a><a href="#devices">Devices</a><a href="#support">Remote Support</a><a href="#wipes">Wipe requests</a><a href="#users">Users</a>
<a href="#enroll">Enrollment</a><a href="#policy">Policy</a><a href="#apps">App catalog</a><a href="#software">Software Management</a><a href="#releases">Releases</a><a href="#problems">Problem reports</a><a href="#security">Security Center</a><a href="#monitoring">Employee monitoring</a><a href="#audit">Package audit</a><a href="#activity">Activity</a>
<div class="me"><span id="me-name"></span><span id="me-org" class="muted"></span><button id="logout" class="link">Sign out</button></div></nav>
<main id="main" tabindex="-1"></main></div>
<div id="toast" class="toast" role="status" hidden></div>
<script src="/admin/app.js"></script></body></html>`;

export const APP_CSS = `.rs-view{display:grid;grid-template-columns:1fr 280px;gap:14px}.rs-screen{position:relative;background:#000;border-radius:10px;overflow:hidden;min-height:300px}
.rs-screen video{width:100%;height:auto;display:block;outline:none;cursor:crosshair}.rs-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.rs-chat{display:flex;flex-direction:column;gap:8px}.rs-log{height:260px;overflow:auto;border:1px solid #8884;border-radius:8px;padding:8px;font-size:13px}
.rs-stats{font-size:12px;line-height:1.6}.rs-files{display:flex;flex-direction:column;gap:6px;font-size:13px}.rs-rec{color:#dc2626;font-weight:600}
.rs-clip{width:100%;min-height:60px;box-sizing:border-box}@media (max-width:900px){.rs-view{grid-template-columns:1fr}}

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
.grow{flex:1;margin:0}fieldset{border:1px solid var(--line);border-radius:12px;padding:12px 14px}legend{color:var(--muted);font-size:13px;padding:0 6px}.modal-back{position:fixed;inset:0;background:rgba(2,6,16,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}
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
.qr{display:block;width:232px;height:232px;image-rendering:pixelated;background:#fff;border-radius:10px;padding:0}
.enroll-out{display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:start}.pager{display:flex;gap:10px;align-items:center;margin-top:12px}
pre.report{white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,monospace;background:var(--chip);padding:12px;border-radius:10px;max-height:420px;overflow:auto;margin:0}
@media (max-width:760px){.enroll-out{grid-template-columns:1fr}.shell{grid-template-columns:1fr}.side{flex-direction:row;flex-wrap:wrap;padding:10px}.side .brand{width:100%;padding-bottom:8px}
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
const monNav = (cur) => h('nav', { class: 'row', 'aria-label': 'Employee monitoring' }, [['monitoring', 'Overview'], ['live', 'Live'], ['mlog', 'Activity log'], ['attendance', 'Attendance']]
  .map(([v, l]) => h('a', { href: '#' + v, class: 'button', 'aria-current': v === cur ? 'page' : null }, l)));
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
/** Endpoint isolation (#20 §12): password and the device name, like an erase; time-limited so a lockout ends. */
function isolateDialog(id, hostname) {
  const hours = h('input', { type: 'number', min: 1, max: 72, value: 24, 'aria-label': 'Hours' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Your password' });
  const name = h('input', { 'aria-label': 'Device name' });
  const back = h('div', { class: 'modal-back' });
  const close = () => back.remove();
  const f = h('form', { class: 'card form', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Isolate device', onsubmit: (e) => { e.preventDefault();
    act(() => api('POST', 'devices/' + id + '/commands', { command: 'IsolateEndpoint', args: { hours: Number(hours.value) }, password: pw.value, confirm_name: name.value }).then(close),
      'Isolation sent. The device keeps only its connection to this server until it ends.'); } },
    h('h2', {}, 'Isolate ' + hostname + ' from the network?'),
    h('p', { class: 'muted' }, 'All traffic stops except DHCP, DNS and HTTPS to this server, so you can still scan, review and release it. Isolation ends on its own after the time below.'),
    h('label', {}, 'Hours (1–72)', hours), h('label', {}, 'Your password', pw), h('label', {}, 'Type the device name to confirm', name),
    h('div', { class: 'row' }, h('button', { class: 'danger' }, 'Isolate'), h('button', { type: 'button', onclick: close }, 'Cancel')));
  back.append(f); document.body.append(back); pw.focus();
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
    return [h('p', {}, h('a', { href: '#devices' }, '← Devices')), h('h1', {}, d.hostname || d.id),
      h('div', { class: 'card' }, h('dl', {},
        h('dt', {}, 'Device ID'), h('dd', {}, d.id), h('dt', {}, 'Architecture'), h('dd', {}, d.arch), h('dt', {}, 'Key'), h('dd', {}, d.tpm_backed ? 'TPM-backed' : 'Software'),
        h('dt', {}, 'Enrolled'), h('dd', {}, when(d.enrolled_at)), h('dt', {}, 'Last seen'), h('dd', {}, ago(d.last_seen)),
        h('dt', {}, 'OS / shell / kernel'), h('dd', {}, [hb.os_version, hb.shell_version, hb.kernel_version].map((x) => x || '—').join(' / ')),
        h('dt', {}, 'Policy requested'), h('dd', {}, d.policy.requested_version === null ? 'No policy' : 'Version ' + d.policy.requested_version),
        h('dt', {}, 'Policy observed'), h('dd', {}, d.policy.state === 'applied' ? h('span', { class: 'ok' }, 'Version ' + d.policy.observed_version + ' applied')
          : d.policy.state === 'pending' ? h('span', { class: 'warn' }, 'Device reports version ' + d.policy.observed_version + ' — not yet applied')
          : d.policy.state === 'not_reported' ? h('span', { class: 'warn' }, 'Not yet reported by the device') : (d.policy.observed_version ?? '—')),
        h('dt', {}, 'Update status'), h('dd', {}, hb.update_status || '—'),
        h('dt', {}, 'Inventory'), h('dd', {}, d.inventory ? d.inventory.software_count + ' packages, ' + ago(d.inventory.at) : 'not yet received'),
        h('dt', {}, 'Break-glass password'), h('dd', {}, d.break_glass_escrowed ? 'Escrowed' : 'Not escrowed'),
        h('dt', {}, 'Ownership'), h('dd', {}, d.ownership === 'personal' ? 'Personal' : 'Corporate'),
        h('dt', {}, 'Kiosk'), h('dd', {}, d.kiosk ? h('span', { class: 'chip' }, 'Kiosk: ' + d.kiosk.user + ' · ' + kioskAppLabel(d.kiosk.app)) : 'No'),
        h('dt', {}, 'Status'), h('dd', {}, d.wiped_at ? h('span', { class: 'bad' }, 'Wiped ' + when(d.wiped_at) + ' (must enroll again)') : d.revoked ? h('span', { class: 'bad' }, 'Revoked') : 'Managed'))),
      d.revoked ? null : [h('h2', {}, 'Actions'), h('div', { class: 'row' },
        h('button', { onclick: () => send('RequestLock') }, 'Lock screen'), h('button', { onclick: () => send('RefreshPolicy') }, 'Refresh policy'),
        h('button', { onclick: () => send('ScheduleUpdate') }, 'Install updates'), h('button', { onclick: () => send('RebootDuringWindow') }, 'Restart in maintenance window'),
        // Same names as DIAG_PROFILES (src/console.ts) and the device agent's services/device-agent/src/diagnostics.ts.
        (() => { const prof = h('select', { 'aria-label': 'Diagnostics profile' }, h('option', { value: 'basic' }, 'Basic'), h('option', { value: 'session' }, 'Session logs'), h('option', { value: 'network' }, 'Network'), h('option', { value: 'update' }, 'Updates'));
          return [prof, h('button', { onclick: () => send('CollectApprovedDiagnostics', { bundle_profile: prof.value }) }, 'Collect diagnostics')]; })(),
        h('button', { onclick: () => send('StartMalwareScan', { kind: 'quick' }) }, 'Quick scan'), h('button', { onclick: () => send('StartMalwareScan', { kind: 'full' }) }, 'Full scan'),
        h('button', { onclick: () => send('ReleaseIsolation') }, 'End isolation'),
        h('button', { class: 'danger', onclick: () => isolateDialog(id, d.hostname) }, 'Isolate from network…'),
        h('button', { class: 'danger', onclick: () => { if (confirm('Revoke this device? It stops receiving policy and its credential stops working.')) act(() => api('POST', 'devices/' + id + '/revoke'), 'Device revoked.'); } }, 'Revoke')),
      kioskDevice(id, d.kiosk),
      await deviceSoftwareSection(id, d),
      h('h2', {}, 'Erase'), h('div', { class: 'card row' }, h('p', { class: 'muted grow' }, 'Requires the desktop.devices.wipe permission. A second administrator must approve the request before the device receives it, unless policy waives this for personal devices.'),
        h('button', { class: 'danger', onclick: () => wipeDialog({ request: true, hostname: d.hostname, label: 'Erase device', meta: 'Last seen ' + ago(d.last_seen) + ' · ' + (d.ownership === 'personal' ? 'personal' : 'corporate') + ' device.', note: 'Logged to the audit trail',
          submit: (c, x) => wipeSubmit(() => api('POST', 'wipes', { device_id: id, ...x, ...c }), (r) => r.waived_second_approver ? 'Erase sent. It runs the next time the device connects.' : 'Erase requested. Another administrator must approve it.') }) }, 'Erase device…'))],
      h('h2', {}, 'Commands'), table(['Requested', 'Observed on the device'], d.commands.map((c) => h('tr', {}, h('td', {}, h('b', {}, c.command + ' requested'), h('div', { class: 'muted' }, new Date(c.issued_at).toLocaleString())),
        h('td', {}, h('span', { class: c.state === 'completed' ? 'ok' : c.state === 'failed' || c.state === 'rejected' ? 'bad' : 'warn' }, c.observed + (c.reason ? ' (' + c.reason + ')' : '')))))),
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
      out.replaceChildren(h('div', { class: 'card enroll-out' }, t.qr ? h('img', { class: 'qr', src: qrSvg(t.qr), alt: 'QR code of the enrollment link' }) : null,
        h('div', { class: 'form' }, h('b', {}, 'Enrollment token'), h('p', { class: 'muted' }, 'Shown once. Valid until ' + new Date(t.expires_at).toLocaleString() + ' for ' + t.uses + ' device(s).'),
        h('div', { class: 'secret' }, t.token), h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(t.token).then(() => toast('Copied.')) }, 'Copy token'),
          t.link ? h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(t.link).then(() => toast('Copied.')) }, 'Copy enrollment link') : null),
        t.link ? h('p', { class: 'muted' }, 'In the installer, on the Enroll this device page: scan this code with the camera, or paste the link. The link holds this server\'s address and the token.') : null)));
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
      act(() => api('PUT', 'policy', { policy: { ...p, update_ring: f.update_ring.value || null, update_mode: f.update_mode.value || null, maintenance_window: f.maintenance_window.value || null,
        usb_storage: f.usb_storage.value || null, bluetooth: f.bluetooth.value === '' ? null : f.bluetooth.value === 'true', lock_timeout_max_s: num('lock_timeout_max_s'),
        offline_access_days: num('offline_access_days'), offline_wipe_days: num('offline_wipe_days'),
        login_failures_max: num('login_failures_max'), login_lockout_s: num('login_lockout_s'),
        allow_pin: f.allow_pin.value === '' ? null : f.allow_pin.value === 'true', pin_min_length: num('pin_min_length'), update_mirror: f.update_mirror.value || null,
        ai_assistant: f.ai_assistant.value === '' ? null : f.ai_assistant.value === 'true', ai_models: list('ai_models').length ? list('ai_models') : null,
        desktop_widgets: f.desktop_widgets.value === '' ? null : f.desktop_widgets.value === 'true',
        whatsapp: f.whatsapp.value === '' ? null : f.whatsapp.value === 'true',
        drivers_online_search: f.drivers_online_search.value === '' ? null : f.drivers_online_search.value === 'true',
        drivers_auto_install: f.drivers_auto_install.value === '' ? null : f.drivers_auto_install.value === 'true',
        drivers_auto_install_gpu: f.drivers_auto_install_gpu.value === '' ? null : f.drivers_auto_install_gpu.value === 'true',
        software_install: f.software_install.value || null,
        software_uninstall: f.software_uninstall.value === '' ? null : f.software_uninstall.value === 'true',
        software_update: f.software_update.value === '' ? null : f.software_update.value === 'true',
        update_bandwidth_kbps: num('update_bandwidth_kbps'),
        screen_capture: f.screen_capture.value || null, clipboard_history: f.clipboard_history.value || null,
        antivirus: f.antivirus.value === '' ? null : f.antivirus.value === 'true', av_scan_schedule: f.av_scan_schedule.value || null, av_scan_hour: num('av_scan_hour'),
        av_signature_checks_per_day: num('av_signature_checks_per_day'), av_cpu_quota_percent: num('av_cpu_quota_percent'),
        av_exclusions: list('av_exclusions').length ? list('av_exclusions') : null, firewall_outbound_block: list('firewall_outbound_block').length ? list('firewall_outbound_block') : null,
        firewall_log_blocked: f.firewall_log_blocked.value === '' ? null : f.firewall_log_blocked.value === 'true', security_log_retention_days: num('security_log_retention_days'),
        activity_monitoring: f.activity_monitoring.value === '' ? null : f.activity_monitoring.value === 'true', activity_retention_days: num('activity_retention_days'),
        activity_idle_threshold_s: num('activity_idle_threshold_s'), activity_web_domains: f.activity_web_domains.value === '' ? null : f.activity_web_domains.value === 'true',
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
      h('div', { class: 'row' }, h('label', {}, 'Device PIN sign-in', sel('allow_pin', [['true', 'Allowed'], ['false', 'Off']])),
        h('label', {}, 'Shortest PIN (digits)', h('input', { name: 'pin_min_length', type: 'number', min: 4, max: 12, value: p.pin_min_length ?? '' }))),
      h('div', { class: 'row' }, h('label', {}, 'On-device AI assistant', sel('ai_assistant', [['true', 'Allowed'], ['false', 'Off']])),
        h('label', {}, 'AI models allowed (catalog IDs; empty = all)', h('textarea', { name: 'ai_models' }, (p.ai_models || []).join('\n')))),
      h('div', { class: 'row' }, h('label', {}, 'Desktop widgets (WorkSuite Home on the desktop)', sel('desktop_widgets', [['true', 'Allowed'], ['false', 'Off']])),
        h('label', {}, 'WhatsApp (WhatsApp Web app, pinned by default)', sel('whatsapp', [['true', 'Allowed'], ['false', 'Off']]))),
      h('div', { class: 'row' }, h('label', {}, 'Screenshots and screen snipping', sel('screen_capture', [['allowed', 'Allowed'], ['disabled', 'Off']])),
        h('label', {}, 'Clipboard history (Super+V)', sel('clipboard_history', [['allowed', 'Allowed'], ['disabled', 'Off']]))),
      h('div', { class: 'row' }, h('label', {}, 'Look for drivers online after connecting', sel('drivers_online_search', [['true', 'On'], ['false', 'Off']])),
        h('label', {}, 'Install firmware automatically', sel('drivers_auto_install', [['true', 'On'], ['false', 'Off']])),
        h('label', {}, 'Install the NVIDIA driver automatically', sel('drivers_auto_install_gpu', [['true', 'On'], ['false', 'Off']]))),
      h('div', { class: 'row' }, h('label', {}, 'Users may install', sel('software_install', [['any', 'Any software'], ['approved', 'Approved software'], ['request', 'Approved software, and request others'], ['block', 'Nothing (remote installation only)']])),
        h('label', {}, 'Users may uninstall apps', sel('software_uninstall', [['true', 'Allowed'], ['false', 'Organization only']])),
        h('label', {}, 'Users may update apps', sel('software_update', [['true', 'Allowed'], ['false', 'Organization only']]))),
      h('label', {}, 'Update download limit (KiB/s, 0 = none)', h('input', { name: 'update_bandwidth_kbps', type: 'number', min: 0, value: p.update_bandwidth_kbps ?? '' })),
      h('fieldset', {}, h('legend', {}, 'WorkSuite Security'),
        h('div', { class: 'row' }, h('label', {}, 'Antivirus (ClamAV)', sel('antivirus', [['true', 'On'], ['false', 'Off']])),
          h('label', {}, 'Scheduled scans', sel('av_scan_schedule', [['daily', 'Daily quick, weekly full'], ['weekly', 'Weekly quick, monthly full'], ['off', 'Off']])),
          h('label', {}, 'Not before (hour, 0–23)', h('input', { name: 'av_scan_hour', type: 'number', min: 0, max: 23, value: p.av_scan_hour ?? '' }))),
        h('div', { class: 'row' }, h('label', {}, 'Signature checks per day', h('input', { name: 'av_signature_checks_per_day', type: 'number', min: 1, max: 24, value: p.av_signature_checks_per_day ?? '' })),
          h('label', {}, 'Scan CPU limit (%)', h('input', { name: 'av_cpu_quota_percent', type: 'number', min: 10, max: 100, value: p.av_cpu_quota_percent ?? '' })),
          h('label', {}, 'Security history kept (days)', h('input', { name: 'security_log_retention_days', type: 'number', min: 7, max: 3650, value: p.security_log_retention_days ?? '' }))),
        h('label', {}, 'Scan exclusions (absolute paths, one per line; each one weakens protection)', h('textarea', { name: 'av_exclusions' }, (p.av_exclusions || []).join('\n'))),
        h('div', { class: 'row' }, h('label', { class: 'grow' }, 'Blocked destinations (IP or CIDR, one per line)', h('textarea', { name: 'firewall_outbound_block' }, (p.firewall_outbound_block || []).join('\n'))),
          h('label', {}, 'Report blocked connections', sel('firewall_log_blocked', [['true', 'On'], ['false', 'Off']])))),
      h('fieldset', {}, h('legend', {}, 'Employee monitoring'),
        h('p', { class: 'muted' }, 'Off unless turned on. Employees see a persistent indicator, are told on their first sign-in what is collected, and can see their own data. Collected: active, idle and locked time, time per application, sign-in/out and lock events, device startup and shutdown, and a once-a-minute current state (active/idle/locked and the app in use). Website domains only if turned on below. Never: keystrokes, screenshots, window titles, full web addresses, page titles or file contents.'),
        h('div', { class: 'row' }, h('label', {}, 'Activity monitoring', sel('activity_monitoring', [['true', 'On'], ['false', 'Off']])),
          h('label', {}, 'Keep reports (days)', h('input', { name: 'activity_retention_days', type: 'number', min: 1, max: 730, value: p.activity_retention_days ?? '' })),
          h('label', {}, 'Idle after (seconds)', h('input', { name: 'activity_idle_threshold_s', type: 'number', min: 60, max: 3600, value: p.activity_idle_threshold_s ?? '' })),
          h('label', {}, 'Website domains (WorkSuite web apps only)', sel('activity_web_domains', [['true', 'On'], ['false', 'Off']])))),
      h('label', {}, 'Update mirror (https, optional)', h('input', { name: 'update_mirror', value: p.update_mirror || '' })),
      h('label', {}, 'Allowed apps (catalog IDs, one per line)', h('textarea', { name: 'app_allowlist' }, (p.app_allowlist || []).join('\n'))),
      h('label', {}, 'Approved remote-support tools', h('textarea', { name: 'approved_remotes' }, (p.approved_remotes || []).join('\n'))),
      h('div', {}, h('button', { class: 'primary' }, 'Save and sign policy')));
    if (p.bluetooth !== undefined) f.bluetooth.value = String(p.bluetooth);
    if (p.allow_pin !== undefined) f.allow_pin.value = String(p.allow_pin);
    if (p.ai_assistant !== undefined) f.ai_assistant.value = String(p.ai_assistant);
    if (p.desktop_widgets !== undefined) f.desktop_widgets.value = String(p.desktop_widgets);
    if (p.whatsapp !== undefined && p.whatsapp !== null) f.whatsapp.value = String(p.whatsapp);
    for (const k of ['antivirus', 'firewall_log_blocked', 'activity_monitoring', 'activity_web_domains']) if (p[k] !== undefined && p[k] !== null) f[k].value = String(p[k]);
    for (const k of ['drivers_online_search', 'drivers_auto_install', 'drivers_auto_install_gpu', 'software_uninstall', 'software_update']) if (p[k] !== undefined && p[k] !== null) f[k].value = String(p[k]);
    return [h('h1', {}, 'Policy'), h('p', { class: 'muted' }, 'Current version ' + version + '. Devices verify the signature before applying it.'), f, kioskForm(p)];
  },
  async apps() {
    const { items } = await api('GET', 'catalog');
    const f = h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault();
      const arches = [f.amd64.checked && 'amd64', f.arm64.checked && 'arm64'].filter(Boolean);
      act(() => api('PUT', 'catalog/' + encodeURIComponent(f.source.value + ':' + f.pkg.value), { source: f.source.value, name: f.name.value, arches, required: f.required.checked, blocked: f.blocked.checked, sha256: f.sha256.value || undefined,
        assign: { devices: lines(f.a_devices), users: lines(f.a_users), departments: f.a_departments.value.split('\n').map((x) => x.trim()).filter(Boolean) } }),
        'Catalog updated. Required apps are sent to their devices now.'); } },
      h('div', { class: 'row' }, h('label', {}, 'Source', h('select', { name: 'source' }, h('option', { value: 'flatpak' }, 'Flatpak'), h('option', { value: 'apt' }, 'APT'), h('option', { value: 'appimage' }, 'AppImage'))),
        h('label', {}, 'Package / app ID', h('input', { name: 'pkg', required: true, placeholder: 'org.gimp.GIMP' })), h('label', {}, 'Display name', h('input', { name: 'name', required: true }))),
      h('div', { class: 'row' }, h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'amd64', checked: true }), ' amd64')), h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'arm64', checked: true }), ' arm64')),
        h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'required' }), ' Required (deployed automatically)')),
        h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'blocked' }), ' Blocked'))),
      h('p', { class: 'muted' }, 'Assign to (leave all empty for everyone):'),
      h('div', { class: 'row' }, h('label', {}, 'Devices (IDs)', h('textarea', { name: 'a_devices' })), h('label', {}, 'Users (emails)', h('textarea', { name: 'a_users' })),
        h('label', {}, 'Departments (one per line)', h('textarea', { name: 'a_departments' }))),
      h('label', {}, 'SHA-256 (AppImages only)', h('input', { name: 'sha256' })), h('div', {}, h('button', { class: 'primary' }, 'Add or update')));
    return [h('h1', {}, 'App catalog'), table(['App', 'ID', 'Arch', ''], items.map((i) => h('tr', {}, h('td', {}, i.name, i.required ? h('span', { class: 'chip' }, ' required') : null, i.blocked ? h('span', { class: 'chip bad' }, ' blocked') : null,
      i.assign ? h('div', { class: 'muted' }, assignText(i.assign)) : null), h('td', {}, i.id), h('td', {}, i.arches.join(', ')),
      h('td', {}, h('button', { class: 'danger', onclick: () => act(() => api('DELETE', 'catalog/' + encodeURIComponent(i.id)), 'Removed from the catalog.') }, 'Remove'))))),
      h('h2', {}, 'Add an app'), f];
  },
  async releases() {
    const { items } = await api('GET', 'releases');
    return [h('h1', {}, 'Releases'), h('p', { class: 'muted' }, 'Signed OS releases offered to devices. Publishing uses the release signing key: worksuite-server release-publish.'),
      table(['Ring', 'Arch', 'Version', 'Rollout', 'State', 'Flags'], items.map((r) => h('tr', {}, h('td', {}, r.ring), h('td', {}, r.arch), h('td', {}, r.version), h('td', {}, (r.rollout_percent ?? 100) + '%'), h('td', {}, r.state || 'active'),
        h('td', {}, [r.security && 'security', r.mandatory && 'mandatory', r.critical && 'critical'].filter(Boolean).join(', ') || '—'))))];
  },
  async problems(arg) {
    const page = Number(arg) || 1;
    const r = await api('GET', 'problem-reports?page=' + page);
    return [h('h1', {}, 'Problem reports'), h('p', { class: 'muted' }, 'Reports people reviewed and sent from Settings › About › Report a problem. Opening a report is recorded in Activity.'),
      table(['Sent', 'Person', 'Device', 'Description', 'Includes'], r.items.map((x) => h('tr', { class: 'click', tabindex: 0, onclick: () => { location.hash = 'problem/' + encodeURIComponent(x.id); }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = 'problem/' + encodeURIComponent(x.id); } },
        h('td', {}, when(x.at)), h('td', {}, x.user_name, h('div', { class: 'muted' }, x.user_email)), h('td', {}, x.hostname || (x.device_id ? x.device_id : '—')),
        h('td', {}, x.summary || h('span', { class: 'muted' }, 'No description')), h('td', {}, x.sections.map((s) => h('span', { class: 'chip' }, SECTION_NAMES[s] || s)))))),
      pager(r, 'problems')];
  },
  async problem(id) {
    const r = await api('GET', 'problem-reports/' + encodeURIComponent(id));
    return [h('p', {}, h('a', { href: '#problems' }, '← Problem reports')), h('h1', {}, 'Problem report'),
      h('div', { class: 'card' }, h('dl', {}, h('dt', {}, 'Sent'), h('dd', {}, when(r.at)), h('dt', {}, 'Person'), h('dd', {}, r.user_name + ' (' + r.user_email + ')'),
        h('dt', {}, 'Device'), h('dd', {}, r.device_id ? h('a', { href: '#device/' + encodeURIComponent(r.device_id) }, r.hostname || r.device_id) : 'Not sent from an enrolled device'),
        h('dt', {}, 'Description'), h('dd', {}, r.description || h('span', { class: 'muted' }, 'No description')))),
      r.sections.length ? r.sections.map((s) => [h('h2', {}, SECTION_NAMES[s.id] || s.id), h('pre', { class: 'report' }, s.text || '(empty)')]) : h('p', { class: 'muted' }, 'The person left out every section.')];
  },
  async audit(arg) {
    const [pg, type] = (arg || '').split('~');
    const page = Number(pg) || 1;
    const r = await api('GET', 'device-audit?page=' + page + (type ? '&type=' + encodeURIComponent(type) : ''));
    const filter = h('select', { 'aria-label': 'Event type', onchange: (e) => { location.hash = 'audit/1' + (e.target.value ? '~' + e.target.value : ''); } },
      h('option', { value: '' }, 'All package events'), r.types.map((t) => h('option', { value: t, selected: t === type }, t.replace(/^package\./, '').replace(/_/g, ' '))));
    const detail = (d) => !d ? '—' : Object.entries(d).map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : v)).join(' · ');
    return [h('h1', {}, 'Package audit'), h('p', { class: 'muted' }, 'Privileged package changes on devices (installs, removals, updates, repairs), forwarded by each device agent.'),
      h('div', { class: 'row' }, h('label', {}, 'Show', filter)), h('br'),
      table(['When', 'Device', 'Event', 'Details'], r.items.map((x) => h('tr', {}, h('td', {}, new Date(x.at).toLocaleString()), h('td', {}, h('a', { href: '#device/' + encodeURIComponent(x.device_id) }, x.hostname)),
        h('td', {}, x.type.replace(/^package\./, '').replace(/_/g, ' ')), h('td', { class: 'muted' }, detail(x.data))))),
      pager(r, 'audit', type ? '~' + type : '')];
  },
  // Device Management › Remote Support (issue #19). The device's user approves each session unless the policy's
  // disclosed unattended access applies; what the console shows as active is what the device reported.
  async support() {
    const r = await api('GET', 'remote-support');
    const c = r.cards;
    const stat = (label, n, cls) => h('div', { class: 'card stat' }, h('b', { class: cls }, n), label);
    const dur = (s) => s ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : '—';
    const STATUS = { online: 'Online', offline: 'Offline', busy: 'In session' };
    const END = { denied: 'Denied by user', consent_timeout: 'No answer', user_ended: 'Ended by user', admin_ended: 'Ended by administrator', expired: 'Timed out', no_user: 'Nobody signed in', unenrolled: 'Device unenrolled', busy: 'Device busy' };
    const start = (d) => {
      const reason = prompt('Reason for access (shown to ' + (d.assigned_user || 'the user') + ')');
      if (!reason) return;
      const control = confirm('Request keyboard and mouse control?\nOK = remote control (needs your authenticator code), Cancel = view only.');
      const otp = control ? prompt('Authenticator code') : undefined;
      if (control && !otp) return;
      // Recording (issue #37): only when the policy allows it; the user is told in the consent dialog.
      const record = r.recording_allowed ? confirm('Record this session?\nThe user is told before they allow it, and sees it for the whole session.') : false;
      act(() => api('POST', 'remote-support/sessions', { device_id: d.id, mode: control ? 'control' : 'view', reason, otp, record }), 'Request sent. The user is asked to allow it.');
    };
    const end = (id) => act(() => api('POST', 'remote-support/sessions/' + encodeURIComponent(id) + '/terminate'), 'Session ended.');
    return [h('h1', {}, 'Remote Support'),
      h('p', { class: 'muted' }, 'Every session needs the user\'s approval on the device, who sees an indicator and can stop it at any time, unless the device policy enables unattended access for corporate devices.'),
      h('div', { class: 'grid' }, stat('Online devices', c.online_devices), stat('Active sessions', c.active_sessions), stat('Pending requests', c.pending_requests, c.pending_requests ? 'warn' : ''),
        stat('Offline devices', c.offline_devices), stat('Support technicians', c.support_technicians), stat('Completed sessions', c.completed_sessions)),
      h('h2', {}, 'Devices'),
      table(['Device', 'Assigned employee', 'Organization', 'IP address', 'OS version', 'Status', 'Last seen', ''], r.devices.map((d) => h('tr', {},
        h('td', {}, h('a', { href: '#device/' + encodeURIComponent(d.id) }, d.name)), h('td', {}, d.assigned_user || '—'), h('td', {}, d.organization), h('td', {}, d.ip_address || '—'),
        h('td', {}, d.os_version || '—'), h('td', {}, h('span', { class: 'chip' + (d.status === 'offline' ? ' bad' : '') }, STATUS[d.status])), h('td', {}, ago(d.last_seen)),
        h('td', {}, h('button', { type: 'button', disabled: d.status !== 'online', onclick: () => start(d) }, 'Request support'))))),
      h('h2', {}, 'Session history'),
      table(['Administrator', 'Device', 'User', 'Start', 'End', 'Duration', 'Mode', 'Status', ''], r.history.map((x) => h('tr', {},
        h('td', {}, x.administrator), h('td', {}, x.device), h('td', {}, x.user || '—'), h('td', {}, x.started_at ? when(x.started_at) : '—'), h('td', {}, x.ended_at ? when(x.ended_at) : '—'),
        h('td', {}, dur(x.duration_s)), h('td', {}, (x.granted_mode || x.mode) === 'control' ? 'Full control' : 'View only', x.unattended ? h('div', { class: 'muted' }, 'Unattended policy') : null),
        h('td', {}, x.state === 'ended' ? (END[x.end_reason] || 'Ended') : x.state === 'active' ? h('span', { class: 'ok' }, 'Active') : 'Waiting for user'),
        h('td', {}, x.state === 'active' ? h('a', { href: '#viewer/' + encodeURIComponent(x.id) }, 'Open ') : null, x.state !== 'ended' ? h('button', { type: 'button', onclick: () => end(x.id) }, 'Disconnect') : null,
          x.recording_bytes ? h('div', {}, h('a', { href: '/admin/api/remote-support/sessions/' + encodeURIComponent(x.id) + '/recording', download: '' }, 'Recording')) : null,
          h('div', {}, h('a', { href: '#rsevents/' + encodeURIComponent(x.id) }, 'Chat and files'))))))];
  },
  // Chat and file-transfer audit of one session (issue #37): metadata reported by the device and the viewer.
  async rsevents(id) {
    const { items } = await api('GET', 'remote-support/sessions/' + encodeURIComponent(id) + '/events');
    const what = (e) => e.kind === 'chat' ? 'Chat message (' + e.length + ' characters)' : 'File ' + e.action + ': ' + e.name + ' (' + e.size + ' bytes' + (e.sha256 ? ', SHA-256 ' + e.sha256.slice(0, 16) + '…' : '') + ')' + (e.reason ? ' · ' + e.reason : '');
    return [h('p', {}, h('a', { href: '#support' }, '← Remote Support')), h('h1', {}, 'Chat and files'),
      h('p', { class: 'muted' }, 'What passed over the session\'s data channel, as reported by the device and the viewer. Message text and file contents are not stored.'),
      table(['Time', 'Reported by', 'Direction', 'Event'], items.map((e) => h('tr', {}, h('td', {}, when(e.at)), h('td', {}, e.side === 'device' ? 'Device' : 'Viewer'),
        h('td', {}, e.direction === 'to_device' ? 'To the user' : 'To the administrator'), h('td', {}, what(e)))))];
  },
  // Remote desktop viewer (issue #19): WebRTC from the device's portal screen capture, encrypted by DTLS-SRTP; mouse,
  // keyboard and chat go over the data channel. The device applies input only while its user has granted control.
  async viewer(id) {
    if (rsViewer.stop) rsViewer.stop();
    const base = 'remote-support/sessions/' + encodeURIComponent(id) + '/signal';
    const video = h('video', { autoplay: true, playsinline: true, muted: true, tabindex: 0, 'aria-label': 'Remote screen' });
    const status = h('span', { class: 'muted', role: 'status' }, 'Connecting…');
    const stats = h('div', { class: 'rs-stats muted' }, '—');
    const log = h('div', { class: 'rs-log', 'aria-live': 'polite' });
    const say = (who, text) => { log.append(h('div', {}, h('b', {}, who + ': '), text)); log.scrollTop = log.scrollHeight; };
    let pc = null, dc = null, after = 0, live = true, granted = null, viewOnly = false, lastBytes = 0, lastAt = 0;
    const send = (m) => { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(m)); };
    const sessionUrl = 'remote-support/sessions/' + encodeURIComponent(id);
    let recordAllowed = false, recorder = null, recSeq = 0, recQueue = Promise.resolve();
    // ---- issue #37: files both ways, clipboard, quality, monitors, step-up, recording ----
    const FILE_MAX = 200 * 1024 * 1024, CHUNK = 64 * 1024;
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const outgoing = new Map(), incoming = new Map();
    const fileList = h('div', { class: 'rs-files', 'aria-live': 'polite' });
    const fileRow = (key, text, ...extra) => { let row = fileList.querySelector('[data-k="' + key + '"]'); if (!row) { row = h('div', { 'data-k': key }); fileList.append(row); } row.replaceChildren(text, ...extra); };
    const drain = () => new Promise((res) => { const go = () => (!dc || dc.bufferedAmount < 1024 * 1024 ? res() : setTimeout(go, 50)); go(); });
    const audit = (body) => api('POST', sessionUrl + '/events', body).catch(() => {});
    const fileInput = h('input', { type: 'file', 'aria-label': 'File to send', onchange: async () => {
      const f = fileInput.files[0]; fileInput.value = '';
      if (!f) return;
      if (f.size > FILE_MAX) { toast('Files up to 200 MB can be sent.'); return; }
      const fid = 'a' + Math.random().toString(36).slice(2, 12);
      outgoing.set(fid, f);
      send({ t: 'f-offer', id: fid, name: f.name, size: f.size });
      fileRow(fid, 'Sent ' + f.name + ': waiting for the user to accept…');
    } });
    const sendFile = async (fid) => {
      const f = outgoing.get(fid); if (!f) return;
      const buf = new Uint8Array(await f.arrayBuffer());
      for (let seq = 0, o = 0; o < buf.length; seq++, o += CHUNK) {
        await drain();
        send({ t: 'f-chunk', id: fid, seq, data: b64(buf.subarray(o, o + CHUNK)) });
        fileRow(fid, f.name + ': ' + Math.floor((Math.min(o + CHUNK, buf.length) / Math.max(1, buf.length)) * 100) + ' %');
      }
      send({ t: 'f-end', id: fid, sha256: hex(await crypto.subtle.digest('SHA-256', buf)) });
    };
    const onFileMsg = async (x) => {
      if (x.t === 'f-accept') { fileRow(x.id, 'Sending…'); sendFile(x.id); }
      else if (x.t === 'f-reject') { const f = outgoing.get(x.id); outgoing.delete(x.id); fileRow(x.id, (f ? f.name : 'File') + ': ' + (x.reason === 'too_large' ? 'too large for the device' : 'declined by the user')); }
      else if (x.t === 'f-done') { const f = outgoing.get(x.id); outgoing.delete(x.id); fileRow(x.id, (f ? f.name : 'File') + (x.ok ? ': saved in the user\'s Downloads' : ': failed (' + (x.reason || 'error') + ')')); }
      else if (x.t === 'f-offer') {
        if (typeof x.name !== 'string' || !(x.size >= 0) || x.size > FILE_MAX) return;
        incoming.set(x.id, { name: x.name, size: x.size, parts: [], got: 0 });
        fileRow(x.id, 'The user offers ' + x.name + ' (' + x.size + ' bytes) ', h('button', { type: 'button', onclick: () => { send({ t: 'f-get', id: x.id }); fileRow(x.id, 'Downloading ' + x.name + '…'); } }, 'Download'),
          h('button', { type: 'button', onclick: () => { send({ t: 'f-reject', id: x.id }); incoming.delete(x.id); fileRow(x.id, x.name + ': declined'); } }, 'Decline'));
      } else if (x.t === 'f-chunk') {
        const f = incoming.get(x.id); if (!f || x.seq !== f.parts.length) return;
        const part = unb64(String(x.data)); f.parts.push(part); f.got += part.length;
        fileRow(x.id, f.name + ': ' + Math.floor((f.got / Math.max(1, f.size)) * 100) + ' %');
      } else if (x.t === 'f-end' || x.t === 'f-cancel') {
        const f = incoming.get(x.id); if (!f) return; incoming.delete(x.id);
        if (x.t === 'f-cancel') { fileRow(x.id, f.name + ': cancelled on the device'); return; }
        const blob = new Blob(f.parts);
        const sha = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
        if (sha !== x.sha256 || f.got !== f.size) { fileRow(x.id, f.name + ': damaged in transfer, discarded'); audit({ kind: 'file', direction: 'to_admin', action: 'failed', name: f.name, size: f.size, reason: 'hash_mismatch' }); return; }
        const a = h('a', { href: URL.createObjectURL(blob), download: f.name }, 'Save ' + f.name);
        fileRow(x.id, a); a.click();
        audit({ kind: 'file', direction: 'to_admin', action: 'completed', name: f.name, size: f.size, sha256: sha });
      }
    };
    const clipIn = h('textarea', { class: 'rs-clip', 'aria-label': 'Clipboard text', maxlength: 65536 });
    const clipForm = h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => { if (clipIn.value) send({ t: 'clip', text: clipIn.value }); } }, 'Send to device clipboard'),
      h('button', { type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(clipIn.value).catch(() => {}) }, 'Copy'));
    const quality = h('select', { 'aria-label': 'Quality', onchange: () => send({ t: 'q', preset: quality.value }) },
      h('option', { value: 'low' }, 'Low (720p, 10 fps)'), h('option', { value: 'balanced', selected: true }, 'Balanced (1080p, 20 fps)'), h('option', { value: 'high' }, 'High (1440p, 30 fps)'));
    const monitors = h('select', { 'aria-label': 'Monitor', onchange: () => { if (monitors.value) send({ t: 'mon', id: monitors.value }); } }, h('option', { value: '' }, 'Monitor…'));
    monitors.addEventListener('focus', () => send({ t: 'mon-list' }));
    const recLabel = h('span', { class: 'rs-rec', hidden: true }, '● Recording');
    const recBtn = h('button', { type: 'button', hidden: true, onclick: () => (recorder ? stopRec() : startRec()) }, 'Record');
    const upload = (blob) => {
      // Chunks of at most 900 KB (the server's body limit is 1 MiB), in order.
      for (let o = 0; o < blob.size; o += 900 * 1024) {
        const part = blob.slice(o, o + 900 * 1024), seq = recSeq++;
        recQueue = recQueue.then(() => fetch('/admin/api/' + sessionUrl + '/recording?seq=' + seq, { method: 'POST', credentials: 'same-origin', headers: { 'x-ws-admin': '1', 'content-type': 'video/webm' }, body: part })
          .then((res) => { if (!res.ok) throw new Error('upload ' + res.status); })).catch((e) => { toast('Recording upload failed: ' + e.message); stopRec(); });
      }
    };
    const startRec = () => {
      if (!recordAllowed || !video.srcObject || typeof MediaRecorder === 'undefined') return;
      recorder = new MediaRecorder(video.srcObject, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm', videoBitsPerSecond: 1500000 });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) upload(e.data); };
      recorder.start(4000);
      recLabel.hidden = false; recBtn.textContent = 'Stop recording';
    };
    const stopRec = () => { if (recorder && recorder.state !== 'inactive') recorder.stop(); recorder = null; recLabel.hidden = true; recBtn.textContent = 'Record'; };
    const elevate = h('button', { type: 'button', hidden: true, onclick: async () => {
      const otp = prompt('Remote control needs your authenticator code again, and the user must allow it.\nAuthenticator code');
      if (!otp) return;
      try { await api('POST', sessionUrl + '/elevate', { otp }); toast('The user is asked to allow remote control.'); } catch (e) { toast(e.message); }
    } }, 'Request control');
    const mode = h('button', { type: 'button', onclick: () => { viewOnly = !viewOnly; mode.textContent = viewOnly ? 'Remote control' : 'View only'; } }, 'View only');
    const stop = async (sayBye) => {
      live = false; rsViewer.stop = null; stopRec();
      if (sayBye) await api('POST', base, { type: 'bye' }).catch(() => {});
      if (pc) pc.close();
    };
    rsViewer.stop = () => stop(true);
    const end = () => act(async () => { await stop(true); await api('POST', 'remote-support/sessions/' + encodeURIComponent(id) + '/terminate'); location.hash = 'support'; }, 'Session ended.');
    const pos = (e) => { const r = video.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
    const input = (m) => { if (!viewOnly && granted === 'control') send(m); };
    video.addEventListener('mousemove', (e) => input({ t: 'pm', ...pos(e) }));
    video.addEventListener('mousedown', (e) => { video.focus(); input({ t: 'pb', b: e.button, down: true, ...pos(e) }); e.preventDefault(); });
    video.addEventListener('mouseup', (e) => input({ t: 'pb', b: e.button, down: false, ...pos(e) }));
    video.addEventListener('contextmenu', (e) => e.preventDefault());
    video.addEventListener('wheel', (e) => { input({ t: 'ax', dx: Math.sign(e.deltaX), dy: Math.sign(e.deltaY) }); e.preventDefault(); }, { passive: false });
    video.addEventListener('keydown', (e) => { input({ t: 'k', key: e.key, code: e.code, down: true }); e.preventDefault(); });
    video.addEventListener('keyup', (e) => { input({ t: 'k', key: e.key, code: e.code, down: false }); e.preventDefault(); });
    const chatIn = h('input', { type: 'text', 'aria-label': 'Message', maxlength: 500 });
    const chatForm = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); const t = chatIn.value.trim(); if (!t) return; send({ t: 'chat', text: t }); say('You', t); chatIn.value = ''; } }, chatIn, h('button', { type: 'submit' }, 'Send'));
    const poll = async () => {
      while (live) {
        try {
          const r = await api('GET', base + '?after=' + after);
          granted = r.granted_mode;
          recordAllowed = !!r.record; recBtn.hidden = !recordAllowed; elevate.hidden = granted !== 'view';
          status.textContent = (pc && pc.connectionState === 'connected' ? 'Connected' : 'Waiting for the device') + ' · ' + (granted === 'control' ? 'user allowed remote control' : 'user allowed view only');
          if (!pc) {
            pc = new RTCPeerConnection({ iceServers: r.ice_servers || [] });
            pc.ontrack = (e) => { video.srcObject = e.streams[0] || new MediaStream([e.track]); };
            pc.onicecandidate = (e) => { if (e.candidate) api('POST', base, { type: 'ice', candidate: e.candidate.toJSON() }).catch(() => {}); };
            pc.ondatachannel = (e) => { dc = e.channel; dc.onmessage = (m) => {
              let x; try { x = JSON.parse(m.data); } catch { return; }
              if (x.t === 'chat') say('User', String(x.text).slice(0, 500));
              else if (typeof x.t === 'string' && x.t.startsWith('f-')) onFileMsg(x);
              else if (x.t === 'clip' && typeof x.text === 'string') { clipIn.value = x.text.slice(0, 65536); if (navigator.clipboard && document.hasFocus()) navigator.clipboard.writeText(clipIn.value).catch(() => {}); }
              else if (x.t === 'mons' && Array.isArray(x.items)) monitors.replaceChildren(h('option', { value: '' }, 'Monitor…'), ...x.items.map((it) => h('option', { value: it.id, selected: it.id === x.current }, it.name)));
            }; };
          }
          for (const m of r.messages) {
            after = Math.max(after, m.id);
            if (m.type === 'offer') { await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp }); await pc.setLocalDescription(await pc.createAnswer()); await api('POST', base, { type: 'answer', sdp: pc.localDescription.sdp }); }
            else if (m.type === 'ice' && m.candidate) await pc.addIceCandidate(m.candidate).catch(() => {});
            else if (m.type === 'bye') { status.textContent = 'The user stopped sharing.'; await stop(false); return; }
          }
          if (pc) {
            const rep = await pc.getStats(); let s = '';
            rep.forEach((x) => {
              if (x.type === 'inbound-rtp' && x.kind === 'video') {
                const now = x.timestamp, kbps = lastAt ? Math.round(((x.bytesReceived - lastBytes) * 8) / (now - lastAt)) : 0; lastBytes = x.bytesReceived; lastAt = now;
                s += (x.frameWidth || 0) + '×' + (x.frameHeight || 0) + ' · ' + Math.round(x.framesPerSecond || 0) + ' fps · ' + kbps + ' kbit/s · lost ' + (x.packetsLost || 0) + ' packets · ';
              }
              if (x.type === 'candidate-pair' && x.state === 'succeeded' && x.nominated) s += 'RTT ' + Math.round((x.currentRoundTripTime || 0) * 1000) + ' ms · ';
            });
            stats.textContent = s || '—';
          }
        } catch (e) { status.textContent = e.message; if (/ended|waiting/.test(e.message)) { await stop(false); return; } }
        await new Promise((res) => setTimeout(res, 1000));
      }
    };
    poll();
    return [h('p', {}, h('a', { href: '#support' }, '← Remote Support')), h('h1', {}, 'Remote session'),
      h('div', { class: 'rs-bar' }, h('button', { type: 'button', onclick: () => video.requestFullscreen && video.requestFullscreen() }, 'Full screen'), mode,
        h('button', { type: 'button', onclick: () => { stop(true); setTimeout(() => route(), 300); } }, 'Reconnect'), h('button', { type: 'button', class: 'danger', onclick: end }, 'Disconnect'),
        quality, monitors, elevate, recBtn, recLabel, status),
      h('div', { class: 'rs-view' }, h('div', { class: 'rs-screen' }, video),
        h('div', { class: 'rs-chat' }, h('h2', {}, 'Chat'), log, chatForm,
          h('h2', {}, 'Files'), h('p', { class: 'muted' }, 'Up to 200 MB. The user accepts each file; it is saved in their Downloads.'), fileInput, fileList,
          h('h2', {}, 'Clipboard'), h('p', { class: 'muted' }, 'Text only, while the user has clipboard sharing on.'), clipIn, clipForm,
          h('h2', {}, 'Session information'), stats))];
  },
  async security() {
    const r = await api('GET', 'security');
    const t = r.totals;
    const stat = (label, n, cls) => h('div', { class: 'card stat' }, h('b', { class: n ? cls : '' }, n), label);
    const tone = { protected: 'ok', attention: 'warn', at_risk: 'bad', unavailable: 'muted' };
    const label = { protected: 'Protected', attention: 'Needs attention', at_risk: 'At risk', unavailable: 'Unavailable' };
    return [h('h1', {}, 'Security Center'), h('p', { class: 'muted' }, 'Firewall, antivirus and threats as each device last reported them at check-in. Scans, isolation and its release are on each device\'s page; settings are in Policy › WorkSuite Security.'),
      h('div', { class: 'grid' }, stat('Devices reporting', t.reporting + ' / ' + t.devices), stat('Protected', t.protected, 'ok'), stat('Need attention', t.attention, 'warn'),
        stat('At risk', t.at_risk, 'bad'), stat('Active threats', t.active_threats, 'bad'), stat('Isolated', t.isolated, 'warn'), stat('Firewall off', t.firewall_off, 'bad')),
      h('h2', {}, 'Devices'), table(['Device', 'Status', 'Firewall', 'Antivirus', 'Threats', 'Last scan', 'Last seen'], r.devices.map((d) => { const s = d.security;
        return h('tr', { class: 'click', tabindex: 0, onclick: () => { location.hash = 'device/' + d.id; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = 'device/' + d.id; } },
          h('td', {}, h('b', {}, d.hostname || d.id)),
          h('td', {}, !s ? h('span', { class: 'muted' }, 'Not reported') : h('span', { class: tone[s.overall] || '' }, (label[s.overall] || s.overall) + (s.isolation ? ' · isolated until ' + when(s.isolation.until) : ''))),
          h('td', {}, !s ? '—' : s.firewall && s.firewall.active ? h('span', { class: 'ok' }, 'On' + (s.firewall.policy_rules ? ' · ' + s.firewall.policy_rules + ' blocked' : '')) : h('span', { class: 'bad' }, 'Off')),
          h('td', {}, !s || !s.antivirus ? '—' : !s.antivirus.installed ? h('span', { class: 'bad' }, 'Not installed') : !s.antivirus.enabled ? 'Off by policy'
            : h('span', { class: (s.antivirus.signatures_age_days ?? 0) > 3 ? 'warn' : '' }, 'ClamAV ' + s.antivirus.engine + (s.antivirus.signatures_age_days !== null ? ' · signatures ' + s.antivirus.signatures_age_days + ' d old' : ''))),
          h('td', {}, !s || !s.threats ? '—' : h('span', { class: s.threats.active ? 'bad' : '' }, s.threats.active + ' active, ' + s.threats.quarantined + ' quarantined')),
          h('td', {}, s && s.antivirus && s.antivirus.last_scan ? s.antivirus.last_scan.kind + ', ' + ago(s.antivirus.last_scan.finished) + (s.antivirus.last_scan.error ? ' (failed)' : '') : '—'),
          h('td', {}, ago(d.last_seen))); }))];
  },
  /** #39 Live: each employee's 60-second heartbeat (active, idle or locked, and the app in use). Opening it is audited. */
  async live() {
    const r = await api('GET', 'monitoring/live');
    const tone = { active: 'ok', idle: 'warn', locked: 'muted', offline: 'muted' };
    return [h('h1', {}, 'Employee monitoring'), monNav('live'),
      h('p', { class: 'muted' }, 'Current state from each device\'s heartbeat, sent every minute while monitoring is on. A device silent for ' + Math.round(r.stale_after_s / 60) + ' minutes shows offline. Each time this page is opened or refreshed it is recorded in Activity.'),
      h('div', { class: 'row' }, h('button', { onclick: () => route() }, 'Refresh')),
      table(['Employee', 'Device', 'Status', 'Application', 'Last seen'], r.items.map((x) => h('tr', {},
        h('td', {}, h('b', {}, x.name), h('div', { class: 'muted' }, x.email)), h('td', {}, x.device),
        h('td', {}, h('span', { class: tone[x.status] || '' }, x.status.charAt(0).toUpperCase() + x.status.slice(1))),
        h('td', {}, x.app_name || '—'), h('td', {}, ago(x.last_seen) + ' · ' + when(x.last_seen)))))];
  },
  /** #39 Activity log: filter by employee, device, dates, event type and application or domain; paginated; audited. */
  async mlog(arg) {
    const q = new URLSearchParams(arg || '');
    const r = await api('GET', 'monitoring/log?' + q.toString());
    const go = (over) => { const n = new URLSearchParams(q); for (const [k, v] of Object.entries(over)) { if (v === '' || v === null) n.delete(k); else n.set(k, String(v)); } location.hash = 'mlog/' + encodeURIComponent(n.toString()); };
    const f = h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault(); const x = e.target;
      go({ user: x.user.value, device: x.device.value, from: x.from.value, to: x.to.value, type: x.type.value, app: x.app.value.trim(), page: 1 }); } },
      h('div', { class: 'row' },
        h('label', {}, 'Employee', h('select', { name: 'user' }, h('option', { value: '' }, 'Everyone'), r.users.map((u) => h('option', { value: u.id, selected: String(u.id) === q.get('user') }, u.name)))),
        h('label', {}, 'Device', h('select', { name: 'device' }, h('option', { value: '' }, 'All devices'), r.devices.map((d) => h('option', { value: d.id, selected: d.id === q.get('device') }, d.hostname)))),
        h('label', {}, 'From', h('input', { name: 'from', type: 'date', value: q.get('from') || '' })), h('label', {}, 'To', h('input', { name: 'to', type: 'date', value: q.get('to') || '' })),
        h('label', {}, 'Type', h('select', { name: 'type' }, [['', 'All'], ['login', 'Sign-in'], ['logout', 'Sign-out'], ['lock', 'Lock'], ['unlock', 'Unlock'], ['idle', 'Idle'], ['active', 'Active again'], ['startup', 'Device startup'], ['shutdown', 'Device shutdown'], ['app', 'Application time'], ['web', 'Website (domain)']]
          .map(([v, l]) => h('option', { value: v, selected: v === (q.get('type') || '') }, l)))),
        h('label', {}, 'Application or domain', h('input', { name: 'app', value: q.get('app') || '' })),
        h('button', {}, 'Search')));
    const label = { app: 'Application', web: 'Website', startup: 'Device startup', shutdown: 'Device shutdown', login: 'Sign-in', logout: 'Sign-out', lock: 'Lock', unlock: 'Unlock', idle: 'Idle', active: 'Active again' };
    return [h('h1', {}, 'Employee monitoring'), monNav('mlog'), f,
      h('p', { class: 'muted' }, r.total + ' entries. Each search is recorded in Activity.'),
      table(['Time', 'Employee', 'Device', 'Event', 'Detail'], r.items.map((x) => h('tr', {},
        h('td', {}, x.type === 'app' || x.type === 'web' ? x.day : when(x.at)), h('td', {}, x.user || h('span', { class: 'muted' }, 'Device')), h('td', {}, x.device),
        h('td', {}, label[x.type] || x.type),
        h('td', {}, x.type === 'app' ? x.app_name + ' · ' + (x.duration_s / 3600).toFixed(1) + ' h' : x.type === 'web' ? x.domain + ' · ' + (x.duration_s / 3600).toFixed(1) + ' h' : '')))),
      h('div', { class: 'row' }, h('button', { disabled: r.page <= 1, onclick: () => go({ page: r.page - 1 }) }, 'Previous'), h('span', { class: 'muted' }, 'Page ' + r.page + ' of ' + r.pages),
        h('button', { disabled: r.page >= r.pages, onclick: () => go({ page: r.page + 1 }) }, 'Next'))];
  },
  /** #39 Attendance: first active, last active and total active time per employee and day; CSV; HR webhook. */
  async attendance(arg) {
    const q = new URLSearchParams(arg || '');
    const r = await api('GET', 'monitoring/attendance?' + q.toString());
    const t = (ms) => ms ? new Date(ms).toLocaleTimeString() : '—';
    const w = r.webhook;
    const url = h('input', { type: 'url', placeholder: 'https://hr.example.com/hooks/worksuite', value: w.url || '', 'aria-label': 'Webhook URL', class: 'grow' });
    const secretBox = h('div', {});
    const save = (body) => api('PUT', 'monitoring/hr-webhook', body).then((x) => {
      if (x.secret) secretBox.replaceChildren(h('div', { class: 'card' }, h('b', {}, 'Signing secret (shown once): '), h('code', { class: 'mono' }, x.secret),
        h('p', { class: 'muted' }, 'Verify X-WorkSuite-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>"> with this secret.')));
      toast('Saved.');
    }).catch((e) => toast(e.message));
    return [h('h1', {}, 'Employee monitoring'), monNav('attendance'),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); location.hash = 'attendance/' + encodeURIComponent('from=' + e.target.from.value + '&to=' + e.target.to.value); } },
        h('label', {}, 'From', h('input', { name: 'from', type: 'date', value: r.from })), h('label', {}, 'To', h('input', { name: 'to', type: 'date', value: r.to })), h('button', {}, 'Show'),
        // Fetched with the X-WS-Admin header (a plain link could not send it), then saved from a blob.
        h('button', { type: 'button', onclick: async () => {
          const res = await fetch('/admin/api/monitoring/attendance?format=csv&from=' + r.from + '&to=' + r.to, { credentials: 'same-origin', headers: { 'x-ws-admin': '1' } });
          if (!res.ok) { toast('Export failed (HTTP ' + res.status + ').'); return; }
          const a = h('a', { href: URL.createObjectURL(await res.blob()), download: 'attendance-' + r.from + '-' + r.to + '.csv' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        } }, 'Export CSV')),
      h('p', { class: 'muted' }, 'From the activity reports, across all of an employee\'s devices. Viewing and exporting are recorded in Activity.'),
      table(['Day', 'Employee', 'First active', 'Last active', 'Active'], r.items.map((x) => h('tr', {},
        h('td', {}, x.day), h('td', {}, h('b', {}, x.name), h('div', { class: 'muted' }, x.email)), h('td', {}, t(x.first_active)), h('td', {}, t(x.last_active)), h('td', {}, (x.active_s / 3600).toFixed(1) + ' h')))),
      h('h2', {}, 'HR system webhook'),
      h('div', { class: 'card form' },
        h('p', { class: 'muted' }, 'After each day, its attendance (email, name, first and last active, active seconds; nothing else) is POSTed as JSON to this HTTPS address, signed with HMAC-SHA256.'),
        h('div', { class: 'row' }, url, h('button', { onclick: () => save({ url: url.value, enabled: true }) }, w.configured ? 'Save' : 'Create'),
          w.configured ? h('button', { onclick: () => save({ url: url.value, enabled: !w.enabled }).then(route) }, w.enabled ? 'Pause' : 'Resume') : null,
          w.configured ? h('button', { onclick: () => save({ url: url.value, enabled: w.enabled, rotate_secret: true }) }, 'New secret') : null,
          w.configured ? h('button', { onclick: () => act(() => api('POST', 'monitoring/hr-webhook/send', {}).then((x) => { if (!x.ok) throw new Error('HR system answered ' + x.status); }), 'Sent yesterday\'s attendance.') }, 'Send yesterday now') : null,
          w.configured ? h('button', { class: 'danger', onclick: () => act(() => api('PUT', 'monitoring/hr-webhook', { url: null }), 'Removed.') }, 'Remove') : null),
        w.configured ? h('p', { class: 'muted' }, (w.enabled ? 'Active' : 'Paused') + '. Last delivery: ' + (w.last_at ? when(w.last_at) + ' (' + w.last_status + ')' : 'none') + (w.last_day ? ' · last day accepted ' + w.last_day : '')) : null,
        secretBox)];
  },
  async monitoring(arg) {
    const days = Number(arg) || 7;
    const r = await api('GET', 'monitoring?days=' + days);
    const hrs = (s) => (s / 3600).toFixed(1) + ' h';
    const pick = h('select', { 'aria-label': 'Period', onchange: (e) => { location.hash = 'monitoring/' + e.target.value; } }, [1, 7, 30, 90].map((n) => h('option', { value: n, selected: n === days }, n === 1 ? 'Today' : 'Last ' + n + ' days')));
    return [h('h1', {}, 'Employee monitoring'), monNav('monitoring'),
      h('div', { class: 'card' }, h('p', { class: r.enabled ? '' : 'warn' }, r.enabled ? 'On. Reports are kept for ' + r.retention_days + ' days.' : 'Off. Turn it on in Policy › Employee monitoring; no activity is collected until then.'),
        h('p', { class: 'muted' }, 'Aggregate work activity only: active, idle and locked time, time per application, sign-in and lock events. Employees see that monitoring is on and can view their own data. Each time this page is opened it is recorded in Activity.')),
      h('div', { class: 'row' }, pick),
      h('h2', {}, 'Employees'), table(['Employee', 'Active', 'Idle', 'Locked', 'Days', 'Top applications', 'Last report'], r.employees.map((e) => h('tr', {},
        h('td', {}, h('b', {}, e.name), h('div', { class: 'muted' }, e.email + ' · ' + e.devices.join(', '))), h('td', {}, hrs(e.active_s)), h('td', {}, hrs(e.idle_s)), h('td', {}, hrs(e.locked_s)),
        h('td', {}, String(e.days_reported)), h('td', {}, e.top_apps.slice(0, 5).map((a) => h('div', {}, a.name + ' · ' + hrs(a.active_s)))), h('td', {}, ago(e.last_report))))),
      h('h2', {}, 'Working hours'), table(['Day', 'Employee', 'Device', 'First active', 'Last active', 'Active', 'Idle'], r.daily.map((x) => h('tr', {},
        h('td', {}, x.day), h('td', {}, x.name), h('td', {}, x.device), h('td', {}, x.first_active ? new Date(x.first_active).toLocaleTimeString() : '—'),
        h('td', {}, x.last_active ? new Date(x.last_active).toLocaleTimeString() : '—'), h('td', {}, hrs(x.active_s)), h('td', {}, hrs(x.idle_s)))))];
  },
  async activity() {
    const { items } = await api('GET', 'log');
    return [h('h1', {}, 'Activity'), table(['When', 'Who', 'Action', 'Details'], items.map((l) => h('tr', {}, h('td', {}, when(l.at)), h('td', {}, l.name), h('td', {}, l.action.replace(/_/g, ' ')),
      h('td', { class: 'muted' }, Object.entries(l.detail || {}).map(([k, v]) => k + ': ' + v).join(', ')))))];
  },
};

// ---- problem reports, package audit, enrollment QR ----
const SECTION_NAMES = { system: 'System', services: 'System services', session_services: 'Session services', session_log: 'Session warnings', system_log: 'System errors', packages: 'WorkSuite packages' };
function pager(r, view, suffix) {
  const pages = Math.max(1, Math.ceil(r.total / r.per_page));
  const go = (p) => { location.hash = view + '/' + p + (suffix || ''); };
  return h('nav', { class: 'pager', 'aria-label': 'Pages' }, h('button', { type: 'button', disabled: r.page <= 1, onclick: () => go(r.page - 1) }, 'Previous'),
    h('span', { class: 'muted' }, 'Page ' + r.page + ' of ' + pages + ' · ' + r.total + ' in all'), h('button', { type: 'button', disabled: r.page >= pages, onclick: () => go(r.page + 1) }, 'Next'));
}
/** The server's QR matrix (rows of 0/1) as an SVG data URI (img-src allows data:; nothing is inserted as markup). */
function qrSvg(rows) {
  const n = rows.length, q = 4;
  let d = '';
  rows.forEach((row, y) => { for (let x = 0; x < n; x++) if (row[x] === '1') d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z'; });
  return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * q) + ' ' + (n + 2 * q) + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>');
}

// ---- kiosk mode (WSOS-AUTH-002): set on the Policy page, turned on per device on the device page ----
const KIOSK_MODULES = ['home', 'mail', 'chat', 'calendar', 'tasks', 'files', 'crm', 'hr'];
function kioskAppLabel(a) { return !a ? '—' : a.type === 'url' ? a.url : a.type === 'module' ? 'WorkSuite ' + a.id : a.id; }
function kioskForm(p) {
  const k = p.kiosk || { enabled: false };
  const a = k.app || { type: 'url', url: '' };
  const f = h('form', { class: 'card form', id: 'kiosk', 'aria-labelledby': 'kiosk-h', onsubmit: (e) => { e.preventDefault();
    const type = f.app_type.value;
    const app = type === 'url' ? { type, url: f.app_url.value.trim() } : type === 'module' ? { type, id: f.app_module.value } : { type, id: f.app_desktop.value.trim() };
    const pinOn = f.allow_exit_pin.checked;
    const kiosk = { enabled: f.enabled.checked, user: f.user.value.trim(), devices: k.devices || [], app,
      allowed_urls: f.allowed_urls.value.split(/[\s,]+/).filter(Boolean), idle_reset_minutes: Number(f.idle_reset_minutes.value || 0),
      show_on_screen_keyboard: f.osk.checked, allow_exit_pin: pinOn, orientation: f.orientation.value,
      screen_off: f.screen_off_on.checked ? { from: f.screen_off_from.value, until: f.screen_off_until.value } : null };
    if (pinOn) { if (f.exit_pin.value) kiosk.exit_pin = f.exit_pin.value; else kiosk.exit_pin_set = !!k.exit_pin_set; }
    if (kiosk.enabled && !kiosk.devices.length) kiosk.enabled = false;
    act(() => api('PUT', 'policy', { policy: { ...p, kiosk } }).then((r) => toast('Kiosk settings saved in policy version ' + r.version + '.')));
  } },
    h('p', { class: 'muted' }, 'Kiosk devices sign in automatically as one local account and run a single app full screen: no taskbar, Start menu, Settings, terminal or file manager. USB storage is blocked and only administrators can sign in at the greeter. Turn kiosk mode on for a device on its device page.'),
    h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'enabled', checked: !!k.enabled }), ' Kiosk mode on for the chosen devices (' + (k.devices || []).length + ')')),
    h('div', { class: 'row' }, h('label', {}, 'Kiosk account', h('input', { name: 'user', placeholder: 'kiosk', value: k.user || '', autocomplete: 'off' })),
      h('label', {}, 'Reset after idle (minutes, 0 = never)', h('input', { name: 'idle_reset_minutes', type: 'number', min: 0, max: 1440, value: k.idle_reset_minutes ?? 10 }))),
    h('fieldset', { class: 'form' }, h('legend', {}, 'App'),
      h('label', {}, 'Runs', h('select', { name: 'app_type' }, h('option', { value: 'url', selected: a.type === 'url' }, 'A web address'), h('option', { value: 'module', selected: a.type === 'module' }, 'A WorkSuite module'), h('option', { value: 'desktop', selected: a.type === 'desktop' }, 'An installed app'))),
      h('label', {}, 'Web address (https)', h('input', { name: 'app_url', type: 'url', placeholder: 'https://visitors.example.com/check-in', value: a.type === 'url' ? a.url : '' })),
      h('label', {}, 'WorkSuite module', h('select', { name: 'app_module' }, KIOSK_MODULES.map((m) => h('option', { value: m, selected: a.type === 'module' && a.id === m }, m)))),
      h('label', {}, 'Installed app (.desktop ID)', h('input', { name: 'app_desktop', placeholder: 'org.example.Viewer.desktop', value: a.type === 'desktop' ? a.id : '' }))),
    h('label', {}, 'Other allowed web addresses (one per line; https://host/path, *.host allowed)', h('textarea', { name: 'allowed_urls' }, (k.allowed_urls || []).join('\n'))),
    h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'osk', checked: !!k.show_on_screen_keyboard }), ' Show the on-screen keyboard')),
    h('fieldset', { class: 'form' }, h('legend', {}, 'Screen'),
      h('label', {}, 'Orientation', h('select', { name: 'orientation' }, [['landscape', 'Landscape'], ['portrait', 'Portrait'], ['landscape-flipped', 'Landscape (upside down)'], ['portrait-flipped', 'Portrait (upside down)']]
        .map(([v, l]) => h('option', { value: v, selected: (k.orientation || 'landscape') === v }, l)))),
      h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'screen_off_on', checked: !!k.screen_off }), ' Turn the screen off at night')),
      h('div', { class: 'row' }, h('label', {}, 'Off from', h('input', { name: 'screen_off_from', type: 'time', value: (k.screen_off && k.screen_off.from) || '22:00' })),
        h('label', {}, 'Until', h('input', { name: 'screen_off_until', type: 'time', value: (k.screen_off && k.screen_off.until) || '07:00' }))),
      h('p', { class: 'muted' }, 'Device local time. A touch wakes the screen for a minute.')),
    h('fieldset', { class: 'form' }, h('legend', {}, 'Leaving kiosk mode'),
      h('p', { class: 'muted' }, 'On the device: Ctrl+Alt+Shift+K, or tap the top-left corner five times. An administrator password always works.'),
      h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'allow_exit_pin', checked: !!k.allow_exit_pin }), ' Also allow an exit PIN')),
      h('label', {}, k.exit_pin_set ? 'New exit PIN (leave empty to keep the current one)' : 'Exit PIN (6–12 digits)', h('input', { name: 'exit_pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', pattern: '[0-9]{6,12}' })),
      h('p', { class: 'muted' }, 'The PIN is stored only as a salted hash, on the server and on kiosk devices.')),
    h('div', {}, h('button', { class: 'primary' }, 'Save kiosk settings')));
  return [h('h2', { id: 'kiosk-h' }, 'Kiosk mode'), f];
}
function kioskDevice(id, on) {
  const toggle = async (enable) => {
    const { policy: p } = await api('GET', 'policy');
    const k = p.kiosk;
    if (!k || !k.user || !k.app) { toast('Set the kiosk account and app on the Policy page first.'); location.hash = 'policy'; return; }
    const devices = (k.devices || []).filter((x) => x !== id).concat(enable ? [id] : []);
    const kiosk = { ...k, devices, enabled: devices.length ? (enable || k.enabled) : false };
    await act(() => api('PUT', 'policy', { policy: { ...p, kiosk } }), enable ? 'Kiosk mode turned on. The device restarts into it at its next check-in.' : 'Kiosk mode turned off for this device.');
  };
  return [h('h2', {}, 'Kiosk'), h('div', { class: 'card row' }, h('p', { class: 'muted grow' }, on ? 'This device runs ' + kioskAppLabel(on.app) + ' as ' + on.user + '.' : 'This device runs the full WorkSuite desktop.'),
    on ? h('button', { onclick: () => toggle(false) }, 'Turn off kiosk mode') : h('button', { onclick: () => toggle(true) }, 'Turn on kiosk mode'),
    h('a', { href: '#policy' }, 'Kiosk settings'))];
}

const rsViewer = { stop: null };
const lines = (el) => el.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const assignText = (a) => [a.devices && a.devices.length + ' device(s)', a.users && a.users.join(', '), a.departments && 'departments: ' + a.departments.join(', ')].filter(Boolean).join(' · ');
const STATE_CLASS = { completed: 'ok', failed: 'bad', rejected: 'bad', expired: 'bad' };

/** Device page: department, installed software from the last inventory, remote install and uninstall. */
async function deviceSoftwareSection(id, d) {
  const [sw, cat] = await Promise.all([api('GET', 'devices/' + encodeURIComponent(id) + '/software'), api('GET', 'catalog')]);
  const dept = h('input', { 'aria-label': 'Department', value: d.department || '', placeholder: 'e.g. Finance' });
  const pick = h('select', { 'aria-label': 'Catalog app' }, cat.items.filter((i) => i.source !== 'appimage').map((i) => h('option', { value: i.id }, i.name + ' (' + i.id + ')')));
  const go = (action) => act(() => api('POST', 'software/deploy', { catalog_id: pick.value, action, devices: [id] }), (action === 'install' ? 'Installation' : 'Removal') + ' sent. It runs at the next check-in.');
  return [h('h2', {}, 'Software'),
    h('div', { class: 'card row' }, h('label', {}, 'Department', dept), h('button', { onclick: () => act(() => api('PUT', 'devices/' + id + '/department', { department: dept.value }), 'Department saved.') }, 'Save'),
      d.revoked ? null : [pick, h('button', { onclick: () => go('install') }, 'Install'), h('button', { class: 'danger', onclick: () => go('uninstall') }, 'Uninstall')]),
    h('p', { class: 'muted' }, sw.reported_at ? sw.items.length + ' installed packages and apps, reported ' + ago(sw.reported_at) + '. Catalog apps first.' : 'The device has not reported its inventory yet.'),
    table(['App', 'ID', 'Version'], sw.items.slice().sort((a, b) => (b.catalog_name ? 1 : 0) - (a.catalog_name ? 1 : 0)).slice(0, 300).map((x) =>
      h('tr', {}, h('td', {}, x.catalog_name || '—'), h('td', { class: 'mono' }, x.id), h('td', {}, x.version || '—'))))];
}

views.software = async () => {
  const [reqs, inv, dep] = await Promise.all([api('GET', 'software/requests'), api('GET', 'software/inventory'), api('GET', 'software/deployments')]);
  const host = new Map(inv.devices.map((d) => [d.id, d.hostname || d.id]));
  const decide = (r, ok) => { const note = ok ? '' : (prompt('Reason shown to the user (optional)') || ''); act(() => api('POST', 'software/requests/' + r.id + '/' + (ok ? 'approve' : 'reject'), { note }), ok ? 'Approved. The app installs at the device\'s next check-in.' : 'Request rejected.'); };
  const bulk = (app, action) => {
    const ids = action === 'uninstall' ? app.installed_on : inv.devices.map((d) => d.id).filter((x) => !app.installed_on.includes(x));
    if (!ids.length) { toast('No devices to change.'); return; }
    if (confirm((action === 'install' ? 'Install ' : 'Uninstall ') + app.name + ' on ' + ids.length + ' device(s)?')) act(() => api('POST', 'software/deploy', { catalog_id: app.id, action, devices: ids }), 'Sent to ' + ids.length + ' device(s).');
  };
  return [h('h1', {}, 'Software Management'),
    h('p', { class: 'muted' }, 'Who may install what is set on the Policy page (Users may install / uninstall / update). Assign apps and mark them required in the App catalog.'),
    h('h2', {}, 'Installation requests'),
    table(['App', 'Requested by', 'Device', 'Reason', 'When', 'Decision'], reqs.items.map((r) => h('tr', {},
      h('td', { class: 'mono' }, r.catalog_id), h('td', {}, r.username), h('td', {}, r.hostname || r.device_id), h('td', {}, r.reason || '—'), h('td', {}, when(r.at)),
      h('td', {}, r.state === 'pending' ? h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => decide(r, true) }, 'Approve'), h('button', { onclick: () => decide(r, false) }, 'Reject'))
        : h('span', { class: r.state === 'approved' ? 'ok' : 'bad' }, r.state + (r.install_state ? ' · install ' + r.install_state : '') + (r.note ? ' (' + r.note + ')' : '')))))),
    h('h2', {}, 'Inventory'),
    table(['App', 'Assigned', 'Installed', 'Missing (required)', ''], inv.apps.map((a) => h('tr', {},
      h('td', {}, h('b', {}, a.name), a.required ? h('span', { class: 'chip' }, ' required') : null, a.blocked ? h('span', { class: 'chip bad' }, ' blocked') : null, h('div', { class: 'muted mono' }, a.id)),
      h('td', {}, a.assign ? assignText(a.assign) : 'Everyone', h('div', { class: 'muted' }, a.assigned_devices + ' device(s)')),
      h('td', {}, String(a.installed_on.length)), h('td', { class: a.missing_on.length ? 'warn' : '' }, a.missing_on.map((x) => host.get(x)).join(', ') || '—'),
      h('td', {}, a.id.startsWith('appimage:') ? null : h('div', { class: 'row' }, a.blocked ? null : h('button', { onclick: () => bulk(a, 'install') }, 'Install everywhere'), h('button', { class: 'danger', onclick: () => bulk(a, 'uninstall') }, 'Uninstall everywhere')))))),
    h('h2', {}, 'Devices'),
    table(['Device', 'Department', 'Apps', 'Catalog apps'], inv.devices.map((d) => h('tr', { class: 'click', tabindex: 0, onclick: () => { location.hash = 'device/' + d.id; } },
      h('td', {}, d.hostname || d.id), h('td', {}, d.department || '—'), h('td', {}, d.reported ? String(d.app_count) : 'not reported'), h('td', {}, d.catalog_apps.join(', ') || '—')))),
    h('h2', {}, 'Deployments'),
    table(['App', 'Action', 'Device', 'Sent', 'Status'], dep.items.map((x) => h('tr', {}, h('td', { class: 'mono' }, x.catalog_id), h('td', {}, x.action), h('td', {}, x.hostname || x.device_id), h('td', {}, when(Date.parse(x.issued_at))),
      h('td', {}, h('span', { class: STATE_CLASS[x.state] || 'warn' }, x.state + (x.reason ? ' (' + x.reason + ')' : ''))))))];
};

async function route() {
  if (rsViewer.stop && !location.hash.startsWith('#viewer/')) rsViewer.stop();
  const [view, arg] = (location.hash.slice(1) || 'overview').split('/');
  const fn = views[view] || views.overview;
  for (const a of document.querySelectorAll('.side a')) a.toggleAttribute('aria-current', a.getAttribute('href') === '#' + (view === 'device' ? 'devices' : view === 'problem' ? 'problems' : view === 'viewer' ? 'support' : ['live', 'mlog', 'attendance'].includes(view) ? 'monitoring' : view));
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
