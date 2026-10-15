import { build } from 'esbuild'

// usocket and x11 are dbus-next's optional transports; the shell uses the plain Unix socket.
const external = ['electron', 'usocket', 'x11']
for (const [entry, out] of [['electron/main.ts', 'dist-electron/main.cjs'], ['electron/preload.ts', 'dist-electron/preload.cjs']]) {
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external })
}
