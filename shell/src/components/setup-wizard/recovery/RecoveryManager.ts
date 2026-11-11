// Recovery options for the recovery screen: which actions are available now, and what each preserves or changes.
import type { SetupSnapshot } from '../core/SetupPersistence'
import { isMain, WORK_STATES, type MainState } from '../core/states'
import { planRollback, type RollbackPlan } from './RollbackManager'

export type RecoveryActionId = 'resume' | 'retry' | 'restore' | 'rollback' | 'logs' | 'restart' | 'exit'

export interface RecoveryAction {
  id: RecoveryActionId
  available: boolean
  /** Why it is unavailable, when it is. */
  unavailableReason?: string
  preserves: string
  changes: string
}

export function recoveryOptions(snap: SetupSnapshot): { actions: RecoveryAction[]; rollback: RollbackPlan; failedAt: MainState | null } {
  const failedAt = snap.resumeTo && isMain(snap.resumeTo) ? snap.resumeTo : null
  const unattended = !!failedAt && WORK_STATES.includes(failedAt)
  const rollback = planRollback(snap.mode, failedAt, snap.checkpoints)
  const hasCheckpoint = snap.checkpoints.length > 0
  const act = (id: RecoveryActionId, available: boolean, preserves: string, changes: string, unavailableReason?: string): RecoveryAction =>
    ({ id, available, preserves, changes, ...(available ? {} : { unavailableReason }) })
  return {
    failedAt,
    rollback,
    actions: [
      act('resume', !!failedAt && !unattended, 'All your answers and everything already installed.', `Reopens "${failedAt ?? '—'}" where you left it.`,
        unattended ? 'This step runs on its own; use Retry failed step.' : 'There is no step to resume.'),
      act('retry', unattended, 'All your answers and everything already installed.', `Runs "${failedAt ?? '—'}" again from its start. Downloads continue where they stopped.`, 'Only an unattended step can be retried.'),
      act('restore', hasCheckpoint, 'Answers up to the checkpoint you pick.', 'Answers after it are forgotten. If the disk step has to run again you confirm the disk again. Files already written to the disk are not changed.', 'No checkpoint has been saved yet.'),
      act('rollback', rollback.possible, rollback.possible ? 'Everything up to the rollback point.' : '—',
        rollback.possible ? `${rollback.steps.map((s) => s.undo).join('; ')}.${rollback.notUndone.length ? ` Not undone: ${rollback.notUndone.join(' ')}` : ''}` : '—', rollback.reason),
      act('logs', true, 'Everything.', 'Nothing; shows the installation log.'),
      act('restart', true, 'Whatever is already on the disk.', 'Forgets all answers and checkpoints and starts setup from the beginning. Nothing on the disk is restored.'),
      act('exit', true, 'Everything; setup can be resumed later.', 'Opens the recovery environment (terminal, disk tools, logs).'),
    ],
  }
}
