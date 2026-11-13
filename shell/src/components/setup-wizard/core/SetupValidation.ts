// Validation of the answers each state requires before NEXT may leave it (states.ts `requires`).
export type Validator = (v: unknown, answers: Record<string, unknown>) => string | null

const nonEmpty: Validator = (v) => (typeof v === 'string' && v.trim() ? null : 'required')

export const VALIDATORS: Record<string, Validator> = {
  locale: nonEmpty,
  timezone: (v) => (typeof v === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(v) ? null : 'a time zone such as Asia/Colombo'),
  keyboard: nonEmpty,
  accountType: (v) => (v === 'personal' || v === 'enterprise' ? null : 'personal or enterprise'),
  account: (v) => (v && typeof v === 'object' && typeof (v as { user?: unknown }).user === 'string' ? null : 'sign in or create the account'),
  disk: nonEmpty,
  // Destructive disk writes need an explicit confirmation of the exact device (typed name), never a default.
  diskConfirmed: (v, a) => (typeof v === 'string' && v === a.disk ? null : 'type the disk name to confirm it will be erased'),
  encryption: (v) => (v && typeof v === 'object' && ('enabled' in (v as object)) ? null : 'choose whether to encrypt the disk'),
  worksuiteApps: (v) => (Array.isArray(v) && v.includes('worksuite-desktop') ? null : 'WorkSuite Desktop is required'),
  reviewAccepted: (v) => (v === true ? null : 'review and accept the configuration'),
}

export function validate(requires: readonly string[], answers: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const k of requires) {
    const e = (VALIDATORS[k] ?? nonEmpty)(answers[k], answers)
    if (e) errors[k] = e
  }
  return errors
}
