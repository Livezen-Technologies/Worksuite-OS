// End-to-end driver for the setup app engine: the real plan + AppEngine with the real apt/dpkg/flatpak in a clean
// Debian 13 container. Usage: node drive.ts <scenario>   (state lives in /state, bundled packages in /bundled).
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { CATALOG, type AppDef } from '/src/src/apps/catalog.ts'
import { plan } from '/src/src/apps/plan.ts'
import { AppEngine, readQueue, readStatus } from '/src/src/apps/engine.ts'

const ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive', https_proxy: process.env.https_proxy ?? '', HTTPS_PROXY: process.env.HTTPS_PROXY ?? '' }
const runner = { run: (cmd: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((res) =>
  execFile(cmd, args, { env: ENV, timeout: 3_600_000, maxBuffer: 64 << 20 }, (e, stdout, stderr) => res({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, stdout, stderr }))) }
const scenario = process.argv[2]
const online = process.argv.includes('--offline') ? false : true
const bundledDir = process.argv.includes('--bundled') ? process.argv[process.argv.indexOf('--bundled') + 1] : '/bundled'
const env = { runner, bundledDir, online: () => online, statusFile: '/state/apps.json', queueFile: '/state/app-queue.json', log: (l: string) => console.log(`  | ${l}`), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2000))), retry: { max: 3, backoffMs: 1000 } }
const show = () => console.log(JSON.stringify(readStatus(env.statusFile).map((s) => ({ id: s.id, state: s.state, source: s.source, attempts: s.attempts, ...(s.error ? { error: s.error } : {}), ...(s.why ? { why: s.why } : {}) })), null, 1))

const policy = JSON.parse(readFileSync('/policy.json', 'utf8'))
try {
  if (scenario === 'setup') {
    const sel = process.argv[3].split(',')
    const p = plan(sel, policy)
    console.log('plan:', p.install.map((x) => `${x.app.id}${x.required ? '*' : ''}`).join(' '), '| skipped:', JSON.stringify(p.skipped))
    await new AppEngine(env).run(p)
  } else if (scenario === 'drain') {
    console.log(JSON.stringify(await new AppEngine(env).drain(new Map(CATALOG.map((a) => [a.id, a])))))
  } else if (scenario === 'unresolvable') {
    const cat: AppDef[] = [...CATALOG, { id: 'broken', name: 'Broken app', group: 'third-party', sources: [{ type: 'apt', package: 'worksuite-no-such-package' }] }]
    await new AppEngine(env).run(plan(['broken'], null, cat))
  }
  console.log('RESULT ok')
} catch (e) { console.log(`RESULT threw: ${(e as Error).message}`) }
show()
console.log('queue:', JSON.stringify(readQueue(env.queueFile)))
