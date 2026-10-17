// lk.worksuite.PackageService1 on the system bus. Low-level dispatch so every call sees its sender: the caller's
// UID comes from the bus (never from arguments) and polkit authorizes each privileged call (SRS §10.3, WSOS-ARC-002).
import { readFileSync } from 'node:fs';
import dbus from 'dbus-next';
import { ServiceError } from './apt.ts';
import type { Job, PackageService, Source } from './service.ts';
import type { Coordinator } from './coordinator.ts';
import type { CatalogResult } from './catalog.ts';

const { Message, Variant } = dbus;
type Msg = InstanceType<typeof Message>;
type Bus = ReturnType<typeof dbus.systemBus>;

export const NAME = 'lk.worksuite.PackageService1';
export const PATH = '/lk/worksuite/PackageService1';
const IFACE = NAME;
const ERR = 'lk.worksuite.Error.';
const jobPath = (id: number) => `${PATH}/job/${id}`;

/** Which polkit action guards which method (`null` = read-only, no authorization). */
export const ACTIONS: Record<string, string | null> = {
  Install: 'lk.worksuite.package.install',
  Remove: 'lk.worksuite.package.install',
  Preview: null,
  CheckUpdates: null,
  ApplyUpdate: 'lk.worksuite.update.apply',
  Repair: 'lk.worksuite.repair',
  CancelJob: null,          // ownership check instead
  // Update coordinator (WSOS-AUP-011): status and checks are read-only; installing and deferring need the update action.
  GetUpdateStatus: null,
  CheckForUpdates: null,
  DeferUpdate: 'lk.worksuite.update.apply',
  InstallUpdateNow: 'lk.worksuite.update.apply',
  // App Center catalog from the server (WSOS-APP-001): read-only.
  GetCatalog: null,
  // Local .deb (WSOS-APT-005): the preview stages a copy and runs apt's simulation; installing always asks for an
  // administrator password (auth_admin, no keep) after the user has seen the publisher and plan.
  PreviewLocalDeb: null,
  InstallLocalDeb: 'lk.worksuite.package.install-local',
  // Flatpak (WSOS-FLP-003/004).
  GetAppPermissions: null,
  ResetAppPermissions: 'lk.worksuite.package.install',
  PruneRuntimes: 'lk.worksuite.package.install',
  // WSOS-FLP-001: administrator only, and device policy must permit the remote.
  AddRemote: 'lk.worksuite.package.add-remote',
  // Offline bundles (WSOS-AUP-010).
  InspectBundle: null,
  InstallBundle: 'lk.worksuite.update.apply',
};

export interface Authority {
  uid(sender: string): Promise<number>;
  check(sender: string, action: string): Promise<boolean>;
}

export function busAuthority(bus: Bus): Authority {
  return {
    async uid(sender) {
      const r = await bus.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetConnectionUnixUser', signature: 's', body: [sender] }));
      return Number(r?.body[0]);
    },
    async check(sender, action) {
      const subject = ['system-bus-name', { name: new Variant('s', sender) }];
      const r = await bus.call(new Message({
        destination: 'org.freedesktop.PolicyKit1', path: '/org/freedesktop/PolicyKit1/Authority', interface: 'org.freedesktop.PolicyKit1.Authority',
        member: 'CheckAuthorization', signature: '(sa{sv})sa{ss}us', body: [subject, action, {}, 1, ''],   // 1 = AllowUserInteraction
      }));
      return r?.body[0]?.[0] === true;
    },
  };
}

const v = (sig: string, x: unknown) => new Variant(sig, x);
// dbus-next's types declare newError(msg: string, …) but the implementation takes the method-call Message.
const errorReply = (msg: Msg, name: string, text: string) => Message.newError(msg as unknown as string, name, text);

export function serve(bus: Bus, svc: PackageService, auth: Authority, introspectionXml: string, coordinator?: Coordinator, extra: { catalog?: () => Promise<CatalogResult> } = {}) {
  const sources = new Set<Source>(['apt', 'flatpak']);

  svc.on('progress', (job: Job, percent: number) => bus.send(Message.newSignal(PATH, IFACE, 'JobProgress', 'ous', [jobPath(job.id), percent, job.phase])));
  svc.on('finished', (job: Job) => {
    const result = job.state === 'success' ? 'success' : job.state === 'cancelled' ? 'cancelled' : 'failed';
    const details: Record<string, unknown> = { kind: v('s', job.kind) };
    if (job.error) details.error = v('s', job.error);
    bus.send(Message.newSignal(PATH, IFACE, 'JobFinished', 'osa{sv}', [jobPath(job.id), result, details]));
  });

  coordinator?.on('status', (st: unknown) => bus.send(Message.newSignal(PATH, IFACE, 'UpdateStatusChanged', 's', [JSON.stringify(st)])));

  const props = () => ({ State: v('s', svc.state()), RebootRequired: v('b', svc.rebootRequired) });

  async function call(msg: Msg): Promise<Msg> {
    const sender = msg.sender;
    const member = msg.member;
    if (!(member in ACTIONS)) return errorReply(msg, 'org.freedesktop.DBus.Error.UnknownMethod', member);
    const uid = await auth.uid(sender);
    const action = ACTIONS[member];
    if (action && uid !== 0 && !(await auth.check(sender, action))) throw new ServiceError('NotAuthorized');
    const b = msg.body;
    const src = (s: unknown): Source => { if (!sources.has(s as Source)) throw new ServiceError('InvalidArgs', 'source'); return s as Source; };
    switch (member) {
      case 'Install': return Message.newMethodReturn(msg, 'o', [jobPath(svc.install(uid, src(b[0]), String(b[1])))]);
      case 'Remove': return Message.newMethodReturn(msg, 'o', [jobPath(svc.remove(uid, src(b[0]), String(b[1])))]);
      case 'Preview': {
        const op = b[2] === 'remove' ? 'remove' : 'install';
        return Message.newMethodReturn(msg, 's', [JSON.stringify(await svc.preview(src(b[0]), String(b[1]), op))]);
      }
      case 'CheckUpdates': {
        const u = await svc.checkUpdates();
        return Message.newMethodReturn(msg, 'a{sv}', [{ apt: v('u', u.apt), flatpak: v('u', u.flatpak), packages: v('as', u.packages), flatpaks: v('as', u.flatpaks), reboot_required: v('b', u.reboot_required), state: v('s', u.state) }]);
      }
      case 'ApplyUpdate': {
        const opts = (b[1] ?? {}) as Record<string, { value: unknown }>;
        return Message.newMethodReturn(msg, 'o', [jobPath(svc.applyUpdate(uid, String(b[0] ?? ''), { allow_battery: opts.allow_battery?.value === true }))]);
      }
      case 'Repair': return Message.newMethodReturn(msg, 'o', [jobPath(svc.repair(uid))]);
      case 'GetUpdateStatus':
      case 'CheckForUpdates': {
        if (!coordinator) throw new ServiceError('Failed', 'update coordinator not running');
        if (member === 'CheckForUpdates') await coordinator.check();
        return Message.newMethodReturn(msg, 's', [JSON.stringify(coordinator.status)]);
      }
      case 'DeferUpdate': {
        if (!coordinator) throw new ServiceError('Failed', 'update coordinator not running');
        return Message.newMethodReturn(msg, 'b', [coordinator.defer()]);
      }
      case 'InstallUpdateNow': {
        if (!coordinator) throw new ServiceError('Failed', 'update coordinator not running');
        void coordinator.installNow();
        return Message.newMethodReturn(msg, '', []);
      }
      case 'GetCatalog': {
        if (!extra.catalog) throw new ServiceError('Failed', 'catalog not available');
        return Message.newMethodReturn(msg, 's', [JSON.stringify(await extra.catalog())]);
      }
      case 'PreviewLocalDeb': return Message.newMethodReturn(msg, 's', [JSON.stringify(await svc.previewLocalDeb(uid, String(b[0])))]);
      case 'InstallLocalDeb': return Message.newMethodReturn(msg, 'o', [jobPath(svc.installLocalDeb(uid, String(b[0])))]);
      case 'GetAppPermissions': return Message.newMethodReturn(msg, 's', [JSON.stringify(await svc.appPermissions(String(b[0])))]);
      case 'ResetAppPermissions': return Message.newMethodReturn(msg, 'o', [jobPath(svc.resetAppPermissions(uid, String(b[0])))]);
      case 'PruneRuntimes': return Message.newMethodReturn(msg, 'o', [jobPath(svc.pruneRuntimes(uid))]);
      case 'AddRemote': return Message.newMethodReturn(msg, 'o', [jobPath(svc.addRemote(uid, String(b[0]), String(b[1])))]);
      case 'InspectBundle': return Message.newMethodReturn(msg, 's', [JSON.stringify(svc.inspectBundle(uid, String(b[0])))]);
      case 'InstallBundle': return Message.newMethodReturn(msg, 'o', [jobPath(svc.installBundle(uid, String(b[0])))]);
      case 'CancelJob': {
        const m = /\/job\/(\d+)$/.exec(String(b[0]));
        if (!m) throw new ServiceError('NoSuchJob');
        svc.cancel(uid, Number(m[1]));
        return Message.newMethodReturn(msg, '', []);
      }
    }
    throw new ServiceError('Failed');
  }

  bus.addMethodHandler((msg: Msg) => {
    if (msg.path !== PATH) return false;
    if (msg.interface === 'org.freedesktop.DBus.Introspectable' && msg.member === 'Introspect') {
      bus.send(Message.newMethodReturn(msg, 's', [introspectionXml])); return true;
    }
    if (msg.interface === 'org.freedesktop.DBus.Properties') {
      const all = props() as Record<string, unknown>;
      if (msg.member === 'GetAll') bus.send(Message.newMethodReturn(msg, 'a{sv}', [all]));
      else if (msg.member === 'Get' && msg.body[1] in all) bus.send(Message.newMethodReturn(msg, 'v', [all[msg.body[1]]]));
      else bus.send(errorReply(msg, 'org.freedesktop.DBus.Error.PropertyReadOnly', 'read-only'));
      return true;
    }
    if (msg.interface !== IFACE) return false;
    call(msg).then(
      (reply) => bus.send(reply),
      (e) => bus.send(errorReply(msg, ERR + (e instanceof ServiceError ? e.code : 'Failed'), e instanceof Error ? e.message : 'failed')),
    );
    return true;
  });
}

export const loadIntrospection = (path: string) => readFileSync(path, 'utf8');
