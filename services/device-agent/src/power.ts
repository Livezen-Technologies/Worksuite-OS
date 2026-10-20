// Device startup and shutdown for employee activity monitoring (#39). worksuite-power-events.service (oneshot,
// RemainAfterExit) runs `worksuite-device-agent power-event startup` at boot and `… shutdown` when it is stopped
// during shutdown; each call appends {at, type} to power-events.json in the agent's state directory (root, 0600).
// The daemon sends them with its next check-in (the shutdown one after the next boot) and drops what was sent.
// Recorded only while the device is enrolled and its signed policy has activity_monitoring on; otherwise the file is
// deleted, so nothing about power cycles is kept on an unmonitored device.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AgentState } from './state.ts';

export type PowerEvent = { at: number; type: 'startup' | 'shutdown' };
const MAX = 500;

export const monitoringOn = (s: Pick<AgentState, 'enrolled' | 'policy'>) => s.enrolled && (s.policy as Record<string, unknown> | undefined)?.activity_monitoring === true;

export function readPowerEvents(file: string): PowerEvent[] {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v.filter((e) => Number.isInteger(e?.at) && (e.type === 'startup' || e.type === 'shutdown')).map((e) => ({ at: e.at, type: e.type })) : [];
  } catch { return []; }
}

function write(file: string, ev: PowerEvent[]) {
  writeFileSync(file + '.tmp', JSON.stringify(ev), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

/** Appends one event (newest 500 kept) when monitoring is on; deletes the file when it is off. Returns whether recorded. */
export function recordPowerEvent(file: string, type: PowerEvent['type'], state: Pick<AgentState, 'enrolled' | 'policy'>, now = Date.now()): boolean {
  if (!monitoringOn(state)) { rmSync(file, { force: true }); return false; }
  write(file, [...readPowerEvents(file), { at: now, type }].slice(-MAX));
  return true;
}

/** After the server accepted them: drop the events that were sent, keep any recorded since. */
export function dropSent(file: string, sent: PowerEvent[]) {
  const key = (e: PowerEvent) => `${e.at}:${e.type}`;
  const gone = new Set(sent.map(key));
  const rest = readPowerEvents(file).filter((e) => !gone.has(key(e)));
  if (rest.length) write(file, rest); else rmSync(file, { force: true });
}
