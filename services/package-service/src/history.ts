// Update history for the Update Manager (Settings › Updates › Update history): every OS update, driver or firmware
// install and app update/installation the package service ran, with its outcome. Root-owned JSON in the state
// directory, newest first, capped. People see a title and the outcome; the error text stays here and in the audit log
// for administrators (the shell words failures itself and never shows package-manager output).

export type HistoryKind = 'os' | 'driver' | 'firmware' | 'app';
export type HistoryResult = 'success' | 'failed' | 'cancelled';

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  /** Plain title: "WorkSuite OS 1.4.0", a driver or firmware name, an app id. */
  title: string;
  version: string | null;
  result: HistoryResult;
  /** Service error for administrators (diagnostics); not shown as-is to people. */
  error: string | null;
  started_at: number;
  finished_at: number;
  reboot_required: boolean;
}

export interface HistoryStore { load(): HistoryEntry[]; save(entries: HistoryEntry[]): void }

export const HISTORY_MAX = 200;

export class UpdateHistory {
  private entries: HistoryEntry[];
  private store: HistoryStore;
  constructor(store: HistoryStore) {
    this.store = store;
    let loaded: unknown;
    try { loaded = store.load(); } catch { loaded = []; }
    this.entries = Array.isArray(loaded) ? loaded.filter(valid) : [];
  }

  add(e: HistoryEntry) {
    this.entries = [e, ...this.entries.filter((x) => x.id !== e.id)].slice(0, HISTORY_MAX);
    try { this.store.save(this.entries); } catch { /* history is informational */ }
  }

  list(limit = 50): HistoryEntry[] { return this.entries.slice(0, Math.max(1, Math.min(HISTORY_MAX, limit))); }
}

function valid(x: unknown): x is HistoryEntry {
  const e = x as HistoryEntry;
  return !!e && typeof e.id === 'string' && typeof e.title === 'string' && ['os', 'driver', 'firmware', 'app'].includes(e.kind)
    && ['success', 'failed', 'cancelled'].includes(e.result) && typeof e.finished_at === 'number';
}
