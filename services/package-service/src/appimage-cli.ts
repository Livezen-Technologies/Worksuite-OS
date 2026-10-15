// worksuite-appimage: per-user AppImage manager (see appimage.ts). Runs as the user, never as root.
//   worksuite-appimage list
//   worksuite-appimage inspect FILE
//   worksuite-appimage import FILE [--origin URL]
//   worksuite-appimage approve ID | remove ID
//   worksuite-appimage update ID FILE
//   worksuite-appimage run ID [ARGS...]           (the desktop entry's Exec)
// Output: one JSON object on stdout: {ok:true, value} or {ok:false, code, error}; exit 0 / 1.
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { AppImageError, AppImages, type AppImageEnv } from './appimage.ts';
import type { RunResult } from './service.ts';

const POLICY = '/run/worksuite-device-agent/policy.json';

const run = (cmd: string, args: string[]) => new Promise<RunResult>((resolve) => {
  execFile(cmd, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' } }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 127) : 0, stdout, stderr });
  });
});

export function userEnv(): AppImageEnv {
  return {
    home: homedir(),
    arch: process.arch === 'arm64' ? 'arm64' : 'amd64',
    policy: () => { try { return JSON.parse(readFileSync(POLICY, 'utf8')); } catch { return null; } },
    runner: { run },
    exec: (file, args) => { spawn(file, args, { detached: true, stdio: 'ignore' }).unref(); },
    now: () => Date.now(),
  };
}

async function main(argv: string[]) {
  const m = new AppImages(userEnv());
  const [cmd, a, b, ...rest] = argv;
  switch (cmd) {
    case 'list': return m.list();
    case 'inspect': { const i = await m.inspect(String(a)); return { arch: i.elf.arch, sha256: i.sha256, size: i.size, signature: i.signature }; }
    case 'import': return m.import(String(a), b === '--origin' ? String(rest[0] ?? '') : '');
    case 'approve': return m.approve(String(a));
    case 'remove': return m.remove(String(a));
    case 'update': return m.update(String(a), String(b));
    case 'run': await m.run(String(a), [b, ...rest].filter((x) => x !== undefined)); return true;
    default: throw new AppImageError('InvalidArgs', `unknown command ${cmd ?? ''}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (value) => { process.stdout.write(JSON.stringify({ ok: true, value }) + '\n'); },
    (e) => {
      process.stdout.write(JSON.stringify({ ok: false, code: e instanceof AppImageError ? e.code : 'Failed', error: e instanceof Error ? e.message : String(e) }) + '\n');
      process.exitCode = 1;
      // Launched from the desktop entry: nobody sees stdout, so say why it didn't open.
      if (process.argv[2] === 'run') execFile('notify-send', ['--app-name=App Center', 'AppImage not started', e instanceof Error ? e.message : String(e)], () => {});
    },
  );
}
