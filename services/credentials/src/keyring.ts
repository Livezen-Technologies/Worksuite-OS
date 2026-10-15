// Refresh tokens live only in the Secret Service keyring (WSOS-IDN-002), reached through libsecret's
// `secret-tool` with fixed argument arrays; the secret travels on stdin, never on the command line.
import { execFile } from 'node:child_process';

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  clear(account: string): Promise<void>;
}

const ATTRS = (account: string) => ['service', 'lk.worksuite.oneauth', 'account', account];

function run(args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('secret-tool', args, { timeout: 15_000 }, (err, stdout) => {
      if (err && typeof (err as NodeJS.ErrnoException).code === 'string') return reject(err); // ENOENT etc.
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout });
    });
    child.stdin?.end(input ?? '');
  });
}

export const secretToolStore: SecretStore = {
  async get(account) {
    const r = await run(['lookup', ...ATTRS(account)]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  },
  async set(account, secret) {
    const r = await run(['store', `--label=WorkSuite sign-in (${account})`, ...ATTRS(account)], secret);
    if (r.code !== 0) throw new Error('keyring_unavailable');
  },
  async clear(account) { await run(['clear', ...ATTRS(account)]); },
};

export function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(a) { return data.get(a) ?? null; },
    async set(a, s) { data.set(a, s); },
    async clear(a) { data.delete(a); },
  };
}
