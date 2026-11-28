import { continuousExecutionPolicy } from '../market-hours'
import type { AutonomousCycle } from './model'

export const unusedEntryExpiresAt = (cycle: Pick<AutonomousCycle, 'createdAt' | 'window'>): number =>
  Math.min(
    Date.parse(cycle.window.submissionCutoffAt),
    Math.max(Date.parse(cycle.createdAt), Date.parse(cycle.window.submissionOpenAt)) +
      continuousExecutionPolicy.entryValidityMs,
  )

export const hasExpiredUnusedEntryAdmission = (cycle: AutonomousCycle, observedAt: string): boolean =>
  cycle.schemaVersion === 'bayn.autonomous-cycle.v4' &&
  cycle.bindings.snapshotId === undefined &&
  cycle.bindings.decisionHash === undefined &&
  Date.parse(observedAt) >= unusedEntryExpiresAt(cycle)
