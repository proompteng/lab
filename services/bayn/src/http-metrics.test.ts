import { expect, test } from 'bun:test'

import { ExecutionControllerOutcome } from './execution/controller-status'
import { CycleOperationsCondition, CycleOperationsReason } from './cycle/observability'
import { renderPrometheusMetrics } from './http'
import { initialState } from './runtime-state'
import { config, provenance } from './testing/runtime-fixtures'

test.each([null, 0, 1])('distinguishes unmeasured episodes from a measured count of %s', (episodeCount) => {
  const state = initialState({})
  const metrics = renderPrometheusMetrics(
    {
      ...state,
      cycle: {
        ...state.cycle,
        condition: CycleOperationsCondition.Waiting,
        reason: CycleOperationsReason.LastCycleCompleted,
        economics: {
          accounting: {
            fillCount: 4,
            transactionCount: 4,
            receiptCount: 4,
            realizedCloseCount: 2,
            unaccountedFillCount: 0,
            unreceiptedTransactionCount: 0,
            grossRealizedPnlMicros: '0',
            executionFeesMicros: '0',
            netRealizedPnlAfterExecutionFeesMicros: '0',
          },
          forwardPerformance: {
            createdAt: '2026-09-18T20:05:00.000Z',
            evidenceStatus: 'SUFFICIENT',
            profitability: 'NOT_PROFITABLE',
            grossRealizedPnlMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            netRealizedPnlAfterCostsMicros: '0',
            netRealizedReturnDecimal: '0',
            completedExecutionCount: 4,
            completedPositionEpisodeCount: episodeCount,
            realizedCloseCount: 2,
            accountingReceiptsExact: true,
            ledgerExact: true,
          },
        },
      },
    },
    config,
    provenance,
    config.build.verification,
  )
  expect(metrics).toContain('bayn_forward_performance_completed_execution_count 4\n')
  expect(metrics).toContain(`bayn_forward_performance_position_episodes_measured ${episodeCount === null ? 0 : 1}\n`)
  const episodeLines = metrics
    .split('\n')
    .filter((line) => line.startsWith('bayn_forward_performance_completed_position_episode_count '))
  expect(episodeLines).toEqual(
    episodeCount === null ? [] : [`bayn_forward_performance_completed_position_episode_count ${episodeCount}`],
  )
})

test.each(Object.values(ExecutionControllerOutcome))('exports one active controller outcome for %s', (lastOutcome) => {
  const metrics = renderPrometheusMetrics(
    {
      ...initialState({}),
      executionController: {
        configured: true,
        controllerKey: 'primary',
        planHash: 'f'.repeat(64),
        readAvailable: true,
        checkedAt: '2026-09-17T14:30:00.000Z',
        error: null,
        status: {
          schemaVersion: 1,
          controllerKey: 'primary',
          planHash: 'f'.repeat(64),
          active: true,
          epoch: 1,
          nextSequence: 2,
          lastSequence: 1,
          lastOutcome,
          lastReceiptHash: 'a'.repeat(64),
          completedAt: '2026-09-17T14:30:00.000Z',
        },
      },
    },
    config,
    provenance,
    config.build.verification,
  )
  const outcomes = metrics.split('\n').filter((line) => line.startsWith('bayn_execution_controller_last_outcome{'))
  expect(outcomes).toHaveLength(4)
  expect(outcomes.filter((line) => line.endsWith(' 1'))).toEqual([
    `bayn_execution_controller_last_outcome{outcome="${lastOutcome.toLowerCase()}"} 1`,
  ])
})
