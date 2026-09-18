import { expect, test } from 'bun:test'

import { ExecutionControllerOutcome } from './execution/controller-status'
import { renderPrometheusMetrics } from './http'
import { initialState } from './runtime-state'
import { config, provenance } from './testing/runtime-fixtures'

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
