import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPackageJob, type JobBus } from '../src/packageJob.ts';

function fakeBus(o: { result: string; error?: string; early?: boolean }): JobBus & { calls: unknown[][]; subscribed: boolean } {
  let fn: ((job: string, result: string, error: string | null) => void) | null = null;
  const bus = {
    calls: [] as unknown[][], subscribed: false,
    async onJobFinished(f: typeof fn) { fn = f; bus.subscribed = true; return () => { bus.subscribed = false; }; },
    async call(member: string, sig: string, body: unknown[]) {
      bus.calls.push([member, sig, ...body]);
      const path = '/lk/worksuite/PackageService1/job/7';
      fn!('/lk/worksuite/PackageService1/job/6', 'failed', 'someone else');   // another job's signal is ignored
      if (o.early) fn!(path, o.result, o.error ?? null);
      else setTimeout(() => fn!(path, o.result, o.error ?? null), 5);
      return [path];
    },
  };
  return bus;
}

test('waits for the job and resolves on success, even when the signal beats the reply', async () => {
  for (const early of [false, true]) {
    const bus = fakeBus({ result: 'success', early });
    await runPackageJob(bus, 'Install', 'flatpak', 'org.gimp.GIMP');
    assert.deepEqual(bus.calls, [['Install', 'ss', 'flatpak', 'org.gimp.GIMP']]);
    assert.equal(bus.subscribed, false);
  }
});

test('a failed job rejects with the service error; a silent one times out', async () => {
  await assert.rejects(runPackageJob(fakeBus({ result: 'failed', error: 'not approved by your organization' }), 'Remove', 'apt', 'gimp'), /PACKAGE_JOB_FAILED: not approved/);
  const silent: JobBus = { async onJobFinished() { return () => {}; }, async call() { return ['/x/job/1']; } };
  await assert.rejects(runPackageJob(silent, 'Install', 'apt', 'gimp', 20), /PACKAGE_JOB_TIMEOUT/);
});
