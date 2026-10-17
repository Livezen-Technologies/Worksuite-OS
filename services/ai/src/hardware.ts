// CPU and GPU facts for the thread count and the GPU switch in Settings › AI.
import { readdir } from 'node:fs/promises';

/**
 * Threads for "auto": llama.cpp runs best on about the physical cores and slows when it competes with the desktop,
 * so leave one logical core free on small machines and a quarter on larger ones (at most 16).
 */
export function autoThreads(logical: number): number {
  if (!Number.isFinite(logical) || logical <= 1) return 1;
  if (logical <= 4) return logical - 1;
  return Math.min(16, Math.floor(logical * 0.75));
}

let vulkan: Promise<boolean> | null = null;
/** A render node and an installed Vulkan driver (ICD): llama.cpp's Vulkan build can use the GPU. */
export function hasVulkan(dirs = { dri: '/dev/dri', icd: ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d'] }): Promise<boolean> {
  const check = async () => {
    const dri = await readdir(dirs.dri).catch(() => [] as string[]);
    if (!dri.some((n) => n.startsWith('renderD'))) return false;
    for (const d of dirs.icd) if ((await readdir(d).catch(() => [] as string[])).some((n) => n.endsWith('.json') && !/lvp|lavapipe|swiftshader/i.test(n))) return true;
    return false;
  };
  if (dirs.dri !== '/dev/dri') return check();
  vulkan ??= check();
  return vulkan;
}
