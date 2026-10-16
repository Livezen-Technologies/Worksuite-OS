// Writes src/theme-light.css: light-theme rules for every fixed colour class in the shell (WSOS-DSK-014).
//   node scripts/gen-light-theme.mjs        (lib/lightTheme.test.ts fails when the file is out of date)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { lightThemeCss } from '../src/lib/lightTheme.ts'

const src = path.resolve(import.meta.dirname, '../src')
const files = (d) => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [] })
const { text, classes, skipped } = lightThemeCss(files(src).sort().map((f) => readFileSync(f, 'utf8')))
writeFileSync(path.join(src, 'theme-light.css'), text)
console.log(`${classes.length} colour classes, ${text.split('\n').length - 2} light rules${skipped.length ? `, not mapped: ${skipped.join(' ')}` : ''}`)
