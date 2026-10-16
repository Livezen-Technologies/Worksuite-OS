// SRS §11.6-c: one JSON object per line on stdout (journald), same shape as the other WorkSuite services:
// { ts, service, level, event, ...fields }. Requests carry their request_id; query strings are never logged.
export type Level = 'debug' | 'info' | 'warning' | 'error';
let sink: (line: string) => void = (line) => { process.stdout.write(line + '\n'); };

/** Tests capture the lines; the daemon keeps stdout. */
export function setLogSink(fn: (line: string) => void) { sink = fn; }

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  sink(JSON.stringify({ ts: new Date().toISOString(), service: 'worksuite-server', level, event, ...fields }));
}
