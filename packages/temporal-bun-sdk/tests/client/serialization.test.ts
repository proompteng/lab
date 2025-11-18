import { expect, test } from 'bun:test'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { computeSignalRequestId } from '../../src/client/serialization'

const dataConverter = createDefaultDataConverter()
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('computeSignalRequestId emits lowercase UUID strings', async () => {
  const id = await computeSignalRequestId(
    {
      namespace: 'default',
      workflowId: 'wf-123',
      signalName: 'update',
      identity: 'test-worker',
      args: [{ ready: true }],
    },
    dataConverter,
    { entropy: 'seed-123' },
  )

  expect(id).toMatch(uuidRegex)
})

test('computeSignalRequestId remains deterministic for identical inputs', async () => {
  const first = await computeSignalRequestId(
    {
      namespace: 'default',
      workflowId: 'wf-123',
      runId: 'run-1',
      signalName: 'update',
      identity: 'worker-1',
      args: ['value'],
    },
    dataConverter,
    { entropy: 'seed-xyz' },
  )
  const second = await computeSignalRequestId(
    {
      namespace: 'default',
      workflowId: 'wf-123',
      runId: 'run-1',
      signalName: 'update',
      identity: 'worker-1',
      args: ['value'],
    },
    dataConverter,
    { entropy: 'seed-xyz' },
  )

  expect(first).toBe(second)
})
