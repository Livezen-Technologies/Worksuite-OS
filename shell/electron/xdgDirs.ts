// SRS §11.6-b: per-user state lives in the XDG base directories. $XDG_CONFIG_HOME, $XDG_DATA_HOME, $XDG_CACHE_HOME
// and $XDG_STATE_HOME win when set to an absolute path (relative values are ignored, as the spec requires).
import { isAbsolute, join } from 'node:path'

export interface XdgDirs { config: string; data: string; cache: string; state: string }

export function xdgDirs(home: string, env: Record<string, string | undefined> = process.env): XdgDirs {
  const pick = (v: string | undefined, fallback: string) => (v && isAbsolute(v) ? v : join(home, fallback))
  return {
    config: pick(env.XDG_CONFIG_HOME, '.config'),
    data: pick(env.XDG_DATA_HOME, '.local/share'),
    cache: pick(env.XDG_CACHE_HOME, '.cache'),
    state: pick(env.XDG_STATE_HOME, '.local/state'),
  }
}
