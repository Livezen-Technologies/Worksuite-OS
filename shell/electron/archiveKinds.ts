// Archive kinds by file name, shared by the main process (electron/archives.ts) and the Files window. No Node imports.
export type Kind = 'zip' | '7z' | 'rar' | 'tar' | 'tar.gz' | 'tar.xz' | 'tar.bz2' | 'tar.zst' | 'gz' | 'xz' | 'bz2' | 'zst'

const SUFFIX: [string, Kind][] = [
  ['.tar.gz', 'tar.gz'], ['.tgz', 'tar.gz'], ['.tar.xz', 'tar.xz'], ['.txz', 'tar.xz'], ['.tar.bz2', 'tar.bz2'], ['.tbz2', 'tar.bz2'], ['.tbz', 'tar.bz2'],
  ['.tar.zst', 'tar.zst'], ['.tzst', 'tar.zst'], ['.tar', 'tar'], ['.zip', 'zip'], ['.7z', '7z'], ['.rar', 'rar'], ['.gz', 'gz'], ['.xz', 'xz'], ['.bz2', 'bz2'], ['.zst', 'zst'],
]
const suffixOf = (name: string) => SUFFIX.find(([s]) => name.toLowerCase().endsWith(s) && name.length > s.length) ?? null
/** The archive kind of a file name, or null. */
export const archiveKind = (name: string): Kind | null => suffixOf(name)?.[1] ?? null
/** "Report.tar.gz" -> "Report": the folder name for "Extract to …/" and the file name a stream decompresses to. */
export const stemOf = (name: string) => { const s = suffixOf(name); return s ? name.slice(0, name.length - s[0].length) : name }
