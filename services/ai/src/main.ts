// worksuite-ai.service (systemd user unit, PartOf=worksuite-session.target): the on-device AI assistant's control
// service. It keeps the model catalog and the downloads, checks every model file's SHA-256, applies the organization's
// policy and serves $XDG_RUNTIME_DIR/worksuite/ai.sock (0600). llama.cpp itself runs in worksuite-ai-engine.service,
// which has no network. The only remote calls made anywhere are model downloads from the catalog's hosts.
//
//   worksuite-ai                         serve (the unit's ExecStart)
//   worksuite-ai system-install <id> <file.gguf>
//                                        administrator: check a file against the catalog and install it for everyone
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog, parsePolicy } from './catalog.ts';
import { childEngine, systemdEngine } from './links.ts';
import { LocalAIModelManager, sha256 } from './models.ts';
import { LocalAIRuntime } from './runtime.ts';
import { AIService } from './server.ts';
import { autoThreads } from './hardware.ts';
import { restrictedFetch } from './fetch.ts';
import { cpus } from 'node:os';

export const PATHS = {
  packagedCatalog: '/usr/share/worksuite/ai/catalog.json',
  adminCatalog: '/etc/worksuite/ai-catalog.json',
  policy: '/etc/worksuite/ai-policy.json',
  systemModels: '/var/lib/worksuite/ai/models',
};

const env = process.env;
const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local/share');

async function systemInstall(id: string, file: string): Promise<void> {
  const text = await readFile(PATHS.adminCatalog, 'utf8').catch(() => readFile(PATHS.packagedCatalog, 'utf8'));
  const m = parseCatalog(JSON.parse(text)).models.find((x) => x.id === id);
  if (!m || !m.sha256) throw new Error(`${id} is not in the catalog with a published checksum`);
  if ((await sha256(file)) !== m.sha256) throw new Error(`${file} does not match the SHA-256 the catalog pins for ${id}`);
  const dir = join(PATHS.systemModels, m.id, m.version);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await copyFile(file, join(dir, 'model.gguf.part'));
  await rename(join(dir, 'model.gguf.part'), join(dir, 'model.gguf'));
  process.stdout.write(`Installed ${m.name} for everyone on this computer.\n`);
}

async function serve(): Promise<void> {
  const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  let policy = parsePolicy(read(env.WORKSUITE_AI_POLICY ?? PATHS.policy));
  const root = env.WORKSUITE_AI_ROOT ?? join(dataHome, 'worksuite', 'ai');
  let service: AIService | null = null;
  const models: LocalAIModelManager = new LocalAIModelManager({
    root,
    systemRoot: env.WORKSUITE_AI_SYSTEM_MODELS ?? PATHS.systemModels,
    catalogFiles: env.WORKSUITE_AI_CATALOG ? [env.WORKSUITE_AI_CATALOG] : [PATHS.adminCatalog, PATHS.packagedCatalog],
    policy: () => policy,
    fetch: restrictedFetch(() => models.allowedHosts()),
    onChange: () => service?.changed(),
  });
  const engineSock = join(runtimeDir, 'worksuite', 'ai-engine', 'engine.sock');
  const here = dirname(fileURLToPath(import.meta.url));
  const runtime = new LocalAIRuntime({
    spawn: env.WORKSUITE_AI_ENGINE === 'child' ? childEngine(engineSock, join(here, 'engine-main.ts')) : systemdEngine(engineSock),
    models,
    modelsRoot: root,
    options: () => { const s = models.userSettings(); return { gpu: s.gpu, threads: s.threads || autoThreads(cpus().length) }; },
    onChange: () => service?.changed(),
  });
  service = new AIService({ models, runtime, policy: () => policy });
  await models.init();
  // The device agent rewrites the policy file; a change applies at once (turning AI off stops the engine).
  const policyPath = env.WORKSUITE_AI_POLICY ?? PATHS.policy;
  try {
    watch(dirname(policyPath), (_e, name) => {
      if (name !== null && String(name) !== policyPath.split('/').pop()) return;
      policy = parsePolicy(read(policyPath));
      if (!policy.enabled) void runtime.stop();
      service?.changed();
    }).on('error', () => {});
  } catch { /* no /etc/worksuite yet: unmanaged */ }
  const server = service.serve(env.WORKSUITE_AI_SOCKET ?? join(runtimeDir, 'worksuite', 'ai.sock'));
  const stop = () => { server.close(); void runtime.stop().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'system-install') {
  if (args.length !== 2) { process.stderr.write('usage: worksuite-ai system-install <model-id> <file.gguf>\n'); process.exit(2); }
  systemInstall(args[0]!, args[1]!).catch((e: unknown) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); });
} else {
  void serve();
}
