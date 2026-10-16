// Vitest setup: tests build their own temporary HOME, so the runner's XDG base directories (CI and desktop
// sessions often set them) must not redirect per-user paths away from it. Tests that exercise these variables
// pass them explicitly to xdgDirs(home, env).
for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete process.env[k]
