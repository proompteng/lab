import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { QueryResultType } from '../../src/proto/temporal/api/enums/v1/query_pb'
import { createDefaultDataConverter } from '../../src/common/payloads'
import { defineWorkflow } from '../../src/workflow/definition'
import type { WorkflowContext } from '../../src/workflow/context'
import { WorkflowBlockedError } from '../../src/workflow/errors'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { defineWorkflowQueries } from '../../src/workflow/inbound'
import { WorkflowRegistry } from '../../src/workflow/registry'

const queryHandles = defineWorkflowQueries({
  probe: {
    input: Schema.Struct({}),
    output: Schema.Unknown,
  },
})

const makeExecutor = (operation: (context: WorkflowContext<readonly unknown[]>) => unknown) => {
  const registry = new WorkflowRegistry()
  const executor = new WorkflowExecutor({
    registry,
    dataConverter: createDefaultDataConverter(),
    workflowGuards: 'strict',
  })

  registry.register(
    defineWorkflow('queryGuardWorkflow', Schema.Array(Schema.Unknown), (context) =>
      Effect.gen(function* () {
        yield* context.queries.register(queryHandles.probe, () => Effect.sync(() => operation(context)))
        yield* Effect.fail(new WorkflowBlockedError('query-guard-matrix'))
      }),
    ),
  )

  return executor
}

const evaluateProbeQuery = async (operation: (context: WorkflowContext<readonly unknown[]>) => unknown) =>
  await makeExecutor(operation).execute({
    workflowType: 'queryGuardWorkflow',
    workflowId: 'query-guard-workflow-id',
    runId: 'query-guard-run-id',
    namespace: 'default',
    taskQueue: 'query-guard-task-queue',
    arguments: [],
    queryRequests: [
      {
        id: 'probe-1',
        name: 'probe',
        args: [{}],
        metadata: { identity: 'test' },
        source: 'multi',
      },
    ],
    mode: 'query',
  })

const cases: Array<{
  readonly name: string
  readonly operation: (context: WorkflowContext<readonly unknown[]>) => unknown
  readonly api: string
}> = [
  {
    name: 'determinism.now',
    api: 'advance workflow time',
    operation: (context) => context.determinism.now(),
  },
  {
    name: 'determinism.random',
    api: 'generate new random values',
    operation: (context) => context.determinism.random(),
  },
  {
    name: 'performance.now',
    api: 'performance.now',
    operation: () => performance.now(),
  },
  {
    name: 'setTimeout',
    api: 'setTimeout',
    operation: () => setTimeout(() => {}, 1),
  },
  {
    name: 'fetch',
    api: 'fetch',
    operation: () => fetch('https://example.com'),
  },
]

for (const item of cases) {
  test(`workflow query rejects live ${item.name}`, async () => {
    const output = await evaluateProbeQuery(item.operation)
    const [result] = output.queryResults

    expect(result).toBeDefined()
    expect(result?.result.resultType).toBe(QueryResultType.FAILED)
    expect(result?.result.errorMessage).toContain(item.api)
  })
}

test('workflow query rejects crypto.randomUUID when available', async () => {
  const cryptoRef = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (!cryptoRef?.randomUUID) {
    return
  }

  const output = await evaluateProbeQuery(() => cryptoRef.randomUUID?.())
  const [result] = output.queryResults

  expect(result).toBeDefined()
  expect(result?.result.resultType).toBe(QueryResultType.FAILED)
  expect(result?.result.errorMessage).toContain('crypto.randomUUID')
})

test('workflow query rejects crypto.getRandomValues when available', async () => {
  const cryptoRef = globalThis.crypto as { getRandomValues?: <T extends ArrayBufferView>(array: T) => T } | undefined
  if (!cryptoRef?.getRandomValues) {
    return
  }

  const output = await evaluateProbeQuery(() => {
    const bytes = new Uint8Array(8)
    cryptoRef.getRandomValues?.(bytes)
    return [...bytes]
  })
  const [result] = output.queryResults

  expect(result).toBeDefined()
  expect(result?.result.resultType).toBe(QueryResultType.FAILED)
  expect(result?.result.errorMessage).toContain('crypto.getRandomValues')
})
