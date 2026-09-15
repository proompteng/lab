import { expect, test } from 'bun:test'

import { Authority, KillState, ReconciliationStatus } from '../execution/contracts'
import { CycleState, CycleTerminalReason } from './model'
import {
  CycleOperationsCondition,
  CycleOperationsReason,
  deriveCycleOperationsStatus,
  type CycleOperationsProjection,
} from './observability'

const checkedAt = '2026-08-31T18:00:00.000Z'
const projection: CycleOperationsProjection = {
  current: null,
  last: {
    cycleId: 'a'.repeat(64),
    accountId: 'sandbox-account',
    signalSessionDate: '2026-08-31',
    executionSessionDate: '2026-08-31',
    phase: CycleState.Blocked,
    snapshotId: null,
    decisionHash: null,
    terminalReason: CycleTerminalReason.Authority,
    submissionOpenAt: '2026-08-31T14:30:00.000Z',
    submissionCutoffAt: '2026-08-31T19:00:00.000Z',
    executionOpenAt: '2026-08-31T13:30:00.000Z',
    executionCloseAt: '2026-08-31T20:00:00.000Z',
    createdAt: '2026-08-31T14:00:00.000Z',
    updatedAt: '2026-08-31T17:50:07.281Z',
    terminalAt: '2026-08-31T17:50:07.281Z',
  },
  unfinishedCycleCount: 0,
  authority: {
    generationHash: 'b'.repeat(64),
    maximum: Authority.Execution,
    effective: Authority.Execution,
    kill: KillState.Clear,
    reason: null,
    updatedAt: '2026-08-31T17:50:08.648Z',
  },
  reconciliation: {
    accountId: 'sandbox-account',
    reconciliationId: 'c'.repeat(64),
    status: ReconciliationStatus.Exact,
    discrepancyCount: 0,
    reconciledAt: '2026-08-31T17:59:59.000Z',
    coversLatestMutation: true,
  },
  mutations: {
    eventCount: 0,
    recoveryFoundCount: 0,
    approvedIntentCount: 0,
    acknowledgedIntentCount: 0,
    unresolvedCount: 0,
    oldestUnresolvedAt: null,
    latestOccurredAt: null,
  },
}
const thresholds = {
  cycleStallThresholdMs: 60_000,
  reconciliationStaleThresholdMs: 60_000,
  unknownMutationThresholdMs: 60_000,
}

test('treats a recovered terminal cycle as waiting while current execution authority is clear', () => {
  const status = deriveCycleOperationsStatus(projection, Date.parse(checkedAt), Authority.Execution, thresholds)

  expect(status).toMatchObject({
    condition: CycleOperationsCondition.Waiting,
    reason: CycleOperationsReason.LastCycleBlocked,
    alerts: { cycleFailed: false, killActive: false },
  })
})

test('keeps a non-authority terminal cycle failed while execution authority is configured', () => {
  const status = deriveCycleOperationsStatus(
    {
      ...projection,
      last: projection.last === null ? null : { ...projection.last, terminalReason: CycleTerminalReason.DataInvalid },
    },
    Date.parse(checkedAt),
    Authority.Execution,
    thresholds,
  )

  expect(status).toMatchObject({
    condition: CycleOperationsCondition.Failed,
    reason: CycleOperationsReason.LastCycleBlocked,
    alerts: { cycleFailed: true, killActive: false },
  })
})

test('continues to fail closed when the current authority kill remains active', () => {
  const status = deriveCycleOperationsStatus(
    {
      ...projection,
      authority: projection.authority === null ? null : { ...projection.authority, kill: KillState.Active },
    },
    Date.parse(checkedAt),
    Authority.Execution,
    thresholds,
  )

  expect(status).toMatchObject({
    condition: CycleOperationsCondition.Failed,
    reason: CycleOperationsReason.KillActive,
    alerts: { cycleFailed: true, killActive: true },
  })
})
