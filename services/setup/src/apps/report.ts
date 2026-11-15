// Enterprise deployment sync: what setup reports to the organization, and the defaults the organization sets.
//  - The report (/run/worksuite-setup/report.json, world-readable) holds the setup state and each app's result, never
//    an answer the person typed: no user name, no locale, no error text beyond the engine's own short reasons. The
//    device agent sends it with the inventory (services/device-agent/src/inventory.ts readSetupReport).
//  - Defaults (`setup_defaults` in the signed device policy) pre-fill language, time zone and keyboard; the person can
//    still change them, and the service validates them like any answer.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppStatus } from './engine.ts'

export interface SetupReport {
  state: string
  mode: string
  updated_at: number
  completed_at: number | null
  /** The machine's last error (an action's message), cut to 300 characters. */
  last_error: string | null
  apps: { id: string; state: AppStatus['state']; required: boolean; attempts: number; error: string | null }[]
}

export function buildReport(s: { state: string; mode: string; lastError: string | null }, apps: AppStatus[], now: number, completedAt: number | null): SetupReport {
  return {
    state: s.state, mode: s.mode, updated_at: now, completed_at: completedAt,
    last_error: s.lastError ? s.lastError.slice(0, 300) : null,
    apps: apps.map((a) => ({ id: a.id, state: a.state, required: a.required, attempts: a.attempts, error: a.error ? a.error.slice(0, 300) : null })),
  }
}

export function writeReport(file: string, r: SetupReport) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(r), { mode: 0o644 })
  renameSync(tmp, file)
}

export interface SetupDefaults { locale?: string; timezone?: string; keyboard?: string }
const SHAPE: Record<keyof SetupDefaults, RegExp> = {
  locale: /^[a-z]{2,3}(_[A-Z]{2})?(\.UTF-8)?$/,
  timezone: /^([A-Za-z_]+(\/[A-Za-z0-9_+-]+)+|UTC)$/,
  keyboard: /^[a-z]{2,8}(\+[a-z0-9]{1,16})?$/,
}

/** The organization's defaults that apply now: well-formed and not already answered by the person. */
export function defaultsToApply(defaults: unknown, answers: Readonly<Record<string, unknown>>): [keyof SetupDefaults, string][] {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return []
  const out: [keyof SetupDefaults, string][] = []
  for (const k of Object.keys(SHAPE) as (keyof SetupDefaults)[]) {
    const v = (defaults as Record<string, unknown>)[k]
    if (typeof v === 'string' && SHAPE[k].test(v) && answers[k] === undefined) out.push([k, v])
  }
  return out
}
