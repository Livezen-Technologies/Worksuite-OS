// Line-delimited JSON on a stream socket, with a cap on how long a line may grow (the same framing as the sync and
// credentials sockets, SRS §10.3).
import type { Socket } from 'node:net';

export function readLines(sock: Socket, maxLine: number, onLine: (line: string) => void, onTooLong: () => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > maxLine) { onTooLong(); return; }
      if (line.trim()) onLine(line);
    }
    if (buf.length > maxLine) { buf = ''; onTooLong(); }
  });
}

export const writeLine = (sock: Socket, v: unknown): void => { if (!sock.destroyed && sock.writable) sock.write(JSON.stringify(v) + '\n'); };
