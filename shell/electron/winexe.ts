// Windows programs (WSOS-LCH-003): WorkSuite OS does not run them. Opening one from Files shows an explanation
// instead of handing it to the default app; nothing ever executes it. Other paths (a browser download, another file
// manager, xdg-open) reach shell/apps/worksuite-windows-app.desktop, the default handler for these types, which only
// shows the same explanation (shell/bin/worksuite-windows-app).
import { closeSync, openSync, readSync } from 'node:fs'

export const WINDOWS_EXTENSIONS = ['exe', 'msi', 'msix', 'appx', 'com', 'scr', 'pif', 'bat', 'cmd', 'lnk']

/** Windows program by extension, or by the MZ header when the file has no extension (a download saved without one). */
export function isWindowsProgram(name: string, head: Buffer | null): boolean {
  const base = name.split('/').pop() ?? name
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  if (WINDOWS_EXTENSIONS.includes(ext)) return true
  return !ext && !!head && head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a   // "MZ"
}

/** First bytes of a file (null when it can't be read). */
export function fileHead(p: string, n = 2): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(p, 'r')
    const b = Buffer.alloc(n)
    const got = readSync(fd, b, 0, n, 0)
    return b.subarray(0, got)
  } catch { return null } finally { if (fd !== null) closeSync(fd) }
}
