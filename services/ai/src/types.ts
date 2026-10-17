// Shapes shared by the worksuite-ai service and the shell, ported from WorkSuite Desktop's Local AI
// (Livezen-Technologies/worksuite-desktop shared/local-ai.ts, WS-SRS-LAI). Desktop validates with zod; the OS
// services carry no runtime dependencies beyond node-llama-cpp, so the same rules are written out in catalog.ts.

export const LOCAL_AI_TIERS = ['minimal', 'basic', 'good', 'strong'] as const;
export type LocalAITier = (typeof LOCAL_AI_TIERS)[number];

export interface LocalModel {
  id: string;
  version: string;
  name: string;
  family: string;
  purpose: 'chat' | 'embedding' | 'router';
  /** The GGUF file (https only, on a host the catalog allows). */
  url: string;
  /** Pinned SHA-256 of the file. "" = not published yet: listed, never downloaded. */
  sha256: string;
  /** Exact size in bytes; 0 while the checksum is not published. */
  bytes: number;
  /** OS addition: the size shown before `bytes` is published ("about 2.7 GB"). Never used to verify. */
  approxBytes?: number;
  quantization: string;
  contextLength: number;
  /** Memory the model needs to run (weights + a working context), for the tier check. */
  minMemoryBytes: number;
  tiers: LocalAITier[];
  recommendedFor: LocalAITier[];
  license: { id: string; name: string; url: string };
  notice?: string;
  languages: string[];
  toolCalling: boolean;
}

export interface LocalAICatalog {
  schema: 1;
  issuedAt: string;
  expiresAt: string;
  /** OS addition: the hosts model files may be downloaded from (default: the host of each url must be cdn.worksuite.app). */
  hosts?: string[];
  models: LocalModel[];
}

export interface LocalAIHardware {
  platform: string;
  arch: string;
  memoryBytes: number;
  freeDiskBytes: number | null;
  cpuCores: number;
  cpuModel: string;
  /** The llama.cpp backend in use: vulkan, cuda, or false for CPU only. */
  gpu: string | false;
  /** OS addition: a Vulkan device was seen on this computer (before llama.cpp has started). */
  vulkan: boolean;
  vramBytes: number;
  tier: LocalAITier;
  /** OS addition: the thread count used when the setting is "auto". */
  autoThreads: number;
}

/** A tier from memory (Desktop's thresholds, LAI-HW). */
export function tierFor(memoryBytes: number, vramBytes: number, gpu: string | false): LocalAITier {
  const gb = memoryBytes / 1024 ** 3;
  const vgb = vramBytes / 1024 ** 3;
  if (gb >= 32 || (gpu && vgb >= 10)) return 'strong';
  if (gb >= 16 || (gpu && vgb >= 6)) return 'good';
  if (gb >= 8) return 'basic';
  return 'minimal';
}

export type LocalModelState = 'available' | 'downloading' | 'paused' | 'verifying' | 'installed' | 'failed' | 'unpublished';
export type LocalModelReadiness = 'untested' | 'testing' | 'ready' | 'failed';

export interface LocalModelView {
  model: LocalModel;
  state: LocalModelState;
  received: number;
  error: string | null;
  fits: boolean;
  recommended: boolean;
  isDefault: boolean;
  readiness: LocalModelReadiness;
  readinessError: string | null;
  bytesPerSecond?: number | null;
  /** OS addition: installed for everyone on this computer by an administrator (cannot be removed here). */
  system?: boolean;
}

export type LocalRuntimeState = 'off' | 'starting' | 'ready' | 'loading' | 'busy' | 'error';

/** OS addition: the organization's AI policy (device agent → /etc/worksuite/ai-policy.json). */
export interface AIPolicy {
  managed: boolean;
  enabled: boolean;
  /** Catalog ids the organization allows; null = every model in the catalog. */
  models: string[] | null;
}

export interface AISettings {
  /** The person's own switch (Settings › AI). */
  enabled: boolean;
  /** 0 = auto. */
  threads: number;
  gpu: boolean;
}

export interface LocalAIStatus {
  runtime: LocalRuntimeState;
  /** Why the runtime stopped, as an error code (errors.ts) — the shell words it. */
  error: string | null;
  loaded: string | null;
  hardware: LocalAIHardware | null;
  catalogError: string | null;
  catalogAt: string | null;
  policy: AIPolicy;
  settings: AISettings;
}

export interface LocalMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface LocalAIRequest { id: string; messages: LocalMessage[]; maxTokens?: number; temperature?: number }

export type LocalAIEvent =
  | { id: string; type: 'chunk'; text: string }
  | { id: string; type: 'done'; text: string; tokens: number; ms: number; cancelled: boolean }
  | { id: string; type: 'error'; code: string };
