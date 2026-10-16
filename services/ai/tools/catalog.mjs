#!/usr/bin/env node
/**
 * Model catalog tooling, after WorkSuite Desktop's scripts/local-ai-catalog.mjs. The OS ships catalog/catalog.json
 * in the worksuite-ai package (trusted as every packaged file is); the same body, signed, is what Desktop's CDN serves.
 *
 *   node tools/catalog.mjs hash <model.gguf>                         sha256 and bytes for one entry
 *   node tools/catalog.mjs fill <catalog.json> <models-dir> [out]     fills sha256/bytes from <models-dir>/<id>.gguf
 *   node tools/catalog.mjs sign <catalog.json> <private-key.pem> <key-id> [envelope-out.json]
 *   node tools/catalog.mjs verify <envelope.json> <public-key-base64>
 *
 * A model with "sha256": "" is listed in Settings › AI but cannot be downloaded until `fill` pins its checksum.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };
const hash = async (f) => { const h = createHash('sha256'); for await (const c of createReadStream(f)) h.update(c); return { sha256: h.digest('hex'), bytes: (await stat(f)).size }; };

if (cmd === 'hash') {
  if (!args[0]) die('usage: hash <model.gguf>');
  console.log(JSON.stringify(await hash(args[0])));
} else if (cmd === 'fill') {
  const [file, dir, out] = args;
  if (!file || !dir) die('usage: fill <catalog.json> <models-dir> [out.json]');
  const c = JSON.parse(await readFile(file, 'utf8'));
  for (const m of c.models) {
    const f = join(dir, `${m.id}.gguf`);
    try { Object.assign(m, await hash(f)); delete m.approxBytes; console.error(`${m.id}: ${m.sha256} ${m.bytes}`); } catch { console.error(`${m.id}: no ${f}, left unpublished`); }
  }
  await writeFile(out ?? file, JSON.stringify(c, null, 2) + '\n');
} else if (cmd === 'sign') {
  const [file, keyFile, keyId, out] = args;
  if (!file || !keyFile || !/^[a-z0-9-]{1,40}$/.test(keyId ?? '')) die('usage: sign <catalog.json> <private-key.pem> <key-id> [out]');
  const body = JSON.stringify(JSON.parse(await readFile(file, 'utf8')));
  const signature = sign(null, Buffer.from(body), createPrivateKey(await readFile(keyFile))).toString('base64');
  await writeFile(out ?? 'catalog.envelope.json', JSON.stringify({ body, signature, keyId }));
} else if (cmd === 'verify') {
  const [file, pub] = args;
  const env = JSON.parse(await readFile(file, 'utf8'));
  const ok = verify(null, Buffer.from(env.body), createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }), Buffer.from(env.signature, 'base64'));
  console.log(ok ? 'signature ok' : 'BAD SIGNATURE');
  process.exit(ok ? 0 : 1);
} else die('commands: hash, fill, sign, verify');
