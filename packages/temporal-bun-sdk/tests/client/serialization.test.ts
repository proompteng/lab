import { expect, test } from 'bun:test'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { buildStartWorkflowRequest, computeSignalRequestId } from '../../src/client/serialization'
import { VersioningBehavior } from '../../src/proto/temporal/api/enums/v1/workflow_pb'

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

test('buildStartWorkflowRequest sets versioning behavior when provided', async () => {
  const request = await buildStartWorkflowRequest(
    {
      options: {
        workflowId: 'wf-versioned',
        workflowType: 'exampleWorkflow',
        versioningBehavior: VersioningBehavior.PINNED,
      },
      defaults: {
        namespace: 'default',
        identity: 'test-worker',
        taskQueue: 'example',
      },
    },
    dataConverter,
  )

  expect(request.versioningOverride?.behavior).toBe(VersioningBehavior.PINNED)
})

test('buildStartWorkflowRequest defaults to unversioned behavior', async () => {
  const request = await buildStartWorkflowRequest(
    {
      options: {
        workflowId: 'wf-unversioned',
        workflowType: 'exampleWorkflow',
      },
      defaults: {
        namespace: 'default',
        identity: 'test-worker',
        taskQueue: 'example',
      },
    },
    dataConverter,
  )

  expect(request.versioningOverride).toBeUndefined()
})
