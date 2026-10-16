import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, plan } from './publish-update-center.mjs';

const script = fileURLToPath(new URL('./publish-update-center.mjs', import.meta.url));

function dist() {
  const d = mkdtempSync(join(tmpdir(), 'wsos-pub-'));
  for (const arch of ['amd64', 'arm64']) {
    mkdirSync(join(d, `worksuite-os-${arch}`, 'live-build/out'), { recursive: true });
    const out = join(d, `worksuite-os-${arch}`, 'live-build/out');
    writeFileSync(join(out, `worksuite-os-1.0.0-dev-${arch}.iso`), `iso-${arch}`);
    writeFileSync(join(out, `worksuite-os-1.0.0-dev-${arch}-perf.iso`), 'perf');
    writeFileSync(join(out, `worksuite-os-1.0.0-dev-${arch}.spdx.json`), '{}');
  }
  return d;
}

test('arguments: CI may only publish to pre-release rings', () => {
  assert.equal(parseArgs(['--version', 'v1.2.0']).version, '1.2.0');
  assert.throws(() => parseArgs(['--version', '1.2.0', '--ring', 'stable']), /promote to stable/);
  assert.throws(() => parseArgs(['--ring', 'pilot']), /--version/);
});

test('plan renames ISOs and SBOMs per version and skips perf images', () => {
  const p = plan(dist(), '1.2.0').map((x) => `${x.arch} ${x.remote}`);
  assert.deepEqual(p, ['amd64 worksuite-os-1.2.0-amd64.iso', 'amd64 worksuite-os-1.2.0-amd64.sbom.spdx.json', 'arm64 worksuite-os-1.2.0-arm64.iso', 'arm64 worksuite-os-1.2.0-arm64.sbom.spdx.json']);
});

test('uploads with the bearer token, checks the stored SHA-256 and publishes both arches', async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body.toString() });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/os/releases') { res.statusCode = 201; res.end(JSON.stringify({ data: [{ version: '1.2.0', ring: 'development', arch: 'amd64', state: 'active', rollout_percent: 100, manifest: { signature: 'k1:x' } }] })); return; }
      res.statusCode = 201; res.end(JSON.stringify({ sha256: createHash('sha256').update(body).digest('hex') }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [script, '--version', 'v1.2.0', '--dist', dist(), '--type', 'security'], {
      env: { ...process.env, UC_URL: `http://127.0.0.1:${port}`, UC_ALLOW_HTTP_LOCALHOST: '1', UPDATE_CENTER_TOKEN: 'cid.secret' }, stdio: 'inherit' });
    p.on('exit', resolve);
  });
  srv.close();
  assert.equal(code, 0);
  assert.ok(seen.every((s) => s.auth === 'Bearer cid.secret'));
  assert.ok(seen.some((s) => s.url === '/api/v1/os/artifacts/1.2.0/amd64/worksuite-os-1.2.0-amd64.iso' && s.body === 'iso-amd64'));
  const sha = seen.find((s) => s.url.endsWith('amd64.iso.sha256'));
  assert.equal(sha.body, `${createHash('sha256').update('iso-amd64').digest('hex')}  worksuite-os-1.2.0-amd64.iso\n`);
  const rel = JSON.parse(seen.find((s) => s.url === '/api/v1/os/releases').body);
  assert.deepEqual(rel, { version: '1.2.0', ring: 'development', arches: ['amd64', 'arm64'], release_type: 'security', min_version: '1.2.0' });
});

test('refuses to run without a token or over plain http', async () => {
  const run = (env) => new Promise((resolve) => spawn(process.execPath, [script, '--version', '1.0.0', '--dist', dist()], { env: { PATH: process.env.PATH, ...env } }).on('exit', resolve));
  assert.notEqual(await run({ UC_URL: 'https://x.example' }), 0);
  assert.notEqual(await run({ UC_URL: 'http://x.example', UPDATE_CENTER_TOKEN: 't' }), 0);
});
