// Checkpoints: the verified points setup can resume or roll back to. Taken when a checkpoint state is left forward
// with valid answers (states.ts `checkpoint`), and before every reversible/destructive state, carrying the
// host's rollback handle when one exists.
import type { Checkpoint } from './SetupPersistence'
import type { MainState } from './states'

const MAX = 32

export class SetupCheckpointManager {
  constructor(private list: Checkpoint[] = []) {}
  all(): readonly Checkpoint[] { return this.list }
  latest(): Checkpoint | undefined { return this.list[this.list.length - 1] }
  find(id: string): Checkpoint | undefined { return this.list.find((c) => c.id === id) }
  take(state: MainState, answers: Record<string, unknown>, now: number, rollback?: Checkpoint['rollback']): Checkpoint {
    const cp: Checkpoint = { id: `${state}@${now}-${this.list.length}`, state, at: now, answers: structuredClone(answers), ...(rollback ? { rollback } : {}) }
    this.list.push(cp)
    if (this.list.length > MAX) this.list.splice(0, this.list.length - MAX)
    return cp
  }
  /** Drop checkpoints after `id` (restoring an earlier point makes later ones stale). */
  truncateAfter(id: string) { const i = this.list.findIndex((c) => c.id === id); if (i >= 0) this.list.splice(i + 1) }
  attachRollback(id: string, rollback: NonNullable<Checkpoint['rollback']>) { const c = this.find(id); if (c) c.rollback = rollback }
  clear() { this.list.length = 0 }
}
