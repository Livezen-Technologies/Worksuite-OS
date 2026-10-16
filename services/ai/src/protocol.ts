// Messages between worksuite-ai (control) and worksuite-ai-engine (inference), one JSON object per line over the
// engine's private 0600 socket. Desktop sends the same messages to its `ws-local-ai` utility process; errors here
// are codes, not sentences, so the shell can word them in every language.
import type { EngineInfo, EngineOptions } from './engine.ts';
import type { LocalAIRequest } from './types.ts';

export type ToWorker =
  | { type: 'init'; opts: EngineOptions }
  | { type: 'load'; path: string }
  | { type: 'unload' }
  | { type: 'generate'; req: LocalAIRequest }
  | { type: 'cancel'; id: string }
  | { type: 'ping'; n: number };

export type FromWorker =
  | { type: 'ready'; info: EngineInfo }
  | { type: 'loaded'; path: string; contextLength: number }
  | { type: 'unloaded' }
  | { type: 'chunk'; id: string; text: string }
  | { type: 'done'; id: string; text: string; tokens: number; ms: number; cancelled: boolean }
  | { type: 'error'; id?: string; op?: 'init' | 'load'; code: string }
  | { type: 'pong'; n: number };
