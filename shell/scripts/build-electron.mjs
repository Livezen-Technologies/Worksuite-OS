import { build } from 'esbuild'

for (const [entry, out] of [['electron/main.ts', 'dist-electron/main.cjs'], ['electron/preload.ts', 'dist-electron/preload.cjs']]) {
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'] })
}
