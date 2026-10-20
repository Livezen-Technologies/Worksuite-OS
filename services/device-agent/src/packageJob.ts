// Remote install / uninstall (Software Management) through lk.worksuite.PackageService1: start the job and wait for
// its JobFinished signal, so the command is acknowledged with the real outcome (installed, or why not) rather than
// "queued". The agent runs as root, so the package service skips polkit but keeps every other check (allowlist,
// approved sources, the critical set).

export const PKG_NAME = 'lk.worksuite.PackageService1';
export const PKG_PATH = '/lk/worksuite/PackageService1';

/** The part of a dbus-next bus this needs (tests pass a fake). */
export interface JobBus {
  /** Calls a method on the package service; resolves with the reply body. */
  call(member: string, signature: string, body: unknown[]): Promise<unknown[]>;
  /** Subscribes to JobFinished(job path, result, details); returns an unsubscribe function. */
  onJobFinished(fn: (job: string, result: string, error: string | null) => void): Promise<() => void>;
}

/** Runs Install/Remove and resolves when the job succeeds; rejects with the service's error otherwise. */
export async function runPackageJob(bus: JobBus, member: 'Install' | 'Remove', source: string, name: string, timeoutMs = 30 * 60_000): Promise<void> {
  // Signals can arrive before the method reply tells us the job path, so remember every finished job until then.
  const finished = new Map<string, { result: string; error: string | null }>();
  let waiter: ((r: { result: string; error: string | null }) => void) | null = null;
  let path: string | null = null;
  const off = await bus.onJobFinished((job, result, error) => {
    if (path && job === path) waiter?.({ result, error });
    else finished.set(job, { result, error });
  });
  try {
    const reply = await bus.call(member, 'ss', [source, name]);
    path = String(reply[0]);
    const done = finished.get(path) ?? await new Promise<{ result: string; error: string | null }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('PACKAGE_JOB_TIMEOUT')), timeoutMs);
      waiter = (r) => { clearTimeout(t); resolve(r); };
    });
    if (done.result !== 'success') throw new Error(done.error ? `PACKAGE_JOB_FAILED: ${done.error}`.slice(0, 200) : `PACKAGE_JOB_${done.result.toUpperCase()}`);
  } finally { off(); }
}

/** The real system bus (dbus-next, loaded lazily). */
export async function systemJobBus(): Promise<JobBus & { close(): void }> {
  const { default: dbus } = await import('dbus-next');
  const bus = dbus.systemBus();
  const { Message } = dbus;
  const call = async (member: string, signature: string, body: unknown[], dest = PKG_NAME, path = PKG_PATH, iface = PKG_NAME) => {
    const r = await bus.call(new Message({ destination: dest, path, interface: iface, member, signature, body }));
    if (r && (r as { type?: number }).type === 3) throw new Error(String((r as { body?: unknown[] }).body?.[0] ?? (r as { errorName?: string }).errorName ?? 'dbus error'));
    return (r?.body ?? []) as unknown[];
  };
  return {
    call: (m, s, b) => call(m, s, b),
    async onJobFinished(fn) {
      const rule = `type='signal',interface='${PKG_NAME}',member='JobFinished',path_namespace='${PKG_PATH}'`;
      await call('AddMatch', 's', [rule], 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus');
      const h = (m: { type?: number; interface?: string; member?: string; body?: unknown[] }) => {
        if (m.interface !== PKG_NAME || m.member !== 'JobFinished') return;
        const details = (m.body?.[2] ?? {}) as Record<string, { value?: unknown }>;
        fn(String(m.body?.[0]), String(m.body?.[1]), typeof details.error?.value === 'string' ? details.error.value : null);
      };
      bus.on('message', h);
      return () => { bus.removeListener('message', h); void call('RemoveMatch', 's', [rule], 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus').catch(() => {}); };
    },
    close: () => bus.disconnect(),
  };
}
