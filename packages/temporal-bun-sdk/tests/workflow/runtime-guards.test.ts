import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { installWorkflowRuntimeGuards } from '../../src/workflow/guards'
import { WorkflowNondeterminismError } from '../../src/workflow/errors'
import { runWithWorkflowModuleLoadContext } from '../../src/workflow/module-load'
import type { ExecuteWorkflowInput } from '../../src/workflow/executor'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { defineWorkflow } from '../../src/workflow/definition'
import { WorkflowRegistry } from '../../src/workflow/registry'

type BunRuntimeForGuardTests = {
  readonly env?: Record<string, string | undefined>
  readonly sleep?: (milliseconds: number) => Promise<unknown>
  readonly file?: (...args: unknown[]) => unknown
  readonly write?: (...args: unknown[]) => Promise<unknown> | unknown
  readonly connect?: (...args: unknown[]) => unknown
  readonly serve?: (...args: unknown[]) => { stop?: () => void }
}

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter, workflowGuards: 'strict' })
  return { registry, executor }
}

const execute = async (
  executor: WorkflowExecutor,
  overrides: Partial<ExecuteWorkflowInput> & Pick<ExecuteWorkflowInput, 'workflowType' | 'arguments'>,
) =>
  await executor.execute({
    workflowType: overrides.workflowType,
    arguments: overrides.arguments,
    workflowId: overrides.workflowId ?? 'test-workflow-id',
    runId: overrides.runId ?? 'test-run-id',
    namespace: overrides.namespace ?? 'default',
    taskQueue: overrides.taskQueue ?? 'test-task-queue',
    determinismState: overrides.determinismState,
    activityResults: overrides.activityResults,
    signalDeliveries: overrides.signalDeliveries,
    pendingChildWorkflows: overrides.pendingChildWorkflows,
    queryRequests: overrides.queryRequests,
    updates: overrides.updates,
    mode: overrides.mode,
  })

test('Date.now() is deterministic in workflow context across replays', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('timeWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => [Date.now(), Date.now()]),
    ),
  )

  const first = await execute(executor, { workflowType: 'timeWorkflow', arguments: [] })
  const second = await execute(executor, {
    workflowType: 'timeWorkflow',
    arguments: [],
    determinismState: first.determinismState,
  })

  expect(second.result).toEqual(first.result)
})

test('new Date() is deterministic in workflow context across replays', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('dateWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => [new Date().getTime(), new Date().getTime()]),
    ),
  )

  const first = await execute(executor, { workflowType: 'dateWorkflow', arguments: [] })
  const second = await execute(executor, {
    workflowType: 'dateWorkflow',
    arguments: [],
    determinismState: first.determinismState,
  })

  expect(second.result).toEqual(first.result)
})

test('Math.random() is deterministic in workflow context across replays', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('randomWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => [Math.random(), Math.random()]),
    ),
  )

  const first = await execute(executor, { workflowType: 'randomWorkflow', arguments: [] })
  const second = await execute(executor, {
    workflowType: 'randomWorkflow',
    arguments: [],
    determinismState: first.determinismState,
  })

  expect(second.result).toEqual(first.result)
})

test('crypto.randomUUID() is deterministic in workflow context across replays (when available)', async () => {
  const cryptoRef = (globalThis as unknown as { crypto?: unknown }).crypto as { randomUUID?: () => string } | undefined
  if (!cryptoRef?.randomUUID) {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('uuidWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => [cryptoRef.randomUUID?.(), cryptoRef.randomUUID?.()]),
    ),
  )

  const first = await execute(executor, { workflowType: 'uuidWorkflow', arguments: [] })
  const second = await execute(executor, {
    workflowType: 'uuidWorkflow',
    arguments: [],
    determinismState: first.determinismState,
  })

  expect(second.result).toEqual(first.result)
})

test('crypto.getRandomValues() is deterministic in workflow context across replays (when available)', async () => {
  const cryptoRef = (globalThis as unknown as { crypto?: unknown }).crypto as
    | { getRandomValues?: <T extends ArrayBufferView>(array: T) => T }
    | undefined
  if (!cryptoRef?.getRandomValues) {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('grvWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => {
        const bytes = new Uint8Array(12)
        cryptoRef.getRandomValues?.(bytes)
        cryptoRef.getRandomValues?.(bytes)
        return Array.from(bytes)
      }),
    ),
  )

  const first = await execute(executor, { workflowType: 'grvWorkflow', arguments: [] })
  const second = await execute(executor, {
    workflowType: 'grvWorkflow',
    arguments: [],
    determinismState: first.determinismState,
  })

  expect(second.result).toEqual(first.result)
})

test('fetch() throws in strict mode when called from workflow code', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('fetchWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.tryPromise(async () => {
        await fetch('https://example.com')
        return 'ok'
      }),
    ),
  )

  await expect(execute(executor, { workflowType: 'fetchWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('process.env throws in strict mode when called from workflow code', async () => {
  const envKey = Object.keys(process.env)[0] ?? 'PATH'
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('processEnvWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => process.env[envKey] ?? 'missing'),
    ),
  )

  await expect(execute(executor, { workflowType: 'processEnvWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('Bun.env throws in strict mode when called from workflow code', async () => {
  const bunRef = (globalThis as unknown as { Bun?: BunRuntimeForGuardTests }).Bun
  if (!bunRef?.env) {
    return
  }

  const envKey = Object.keys(bunRef.env)[0] ?? 'PATH'
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunEnvWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => bunRef.env?.[envKey] ?? 'missing'),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunEnvWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('workflow module initialization is guarded in strict mode', async () => {
  installWorkflowRuntimeGuards({ mode: 'strict' })

  await expect(
    runWithWorkflowModuleLoadContext({ mode: 'strict' }, async () => {
      Date.now()
    }),
  ).rejects.toBeInstanceOf(WorkflowNondeterminismError)
})

test('workflow module initialization guards environment reads in strict mode', async () => {
  installWorkflowRuntimeGuards({ mode: 'strict' })
  const envKey = Object.keys(process.env)[0] ?? 'PATH'

  await expect(
    runWithWorkflowModuleLoadContext({ mode: 'strict' }, async () => {
      void process.env[envKey]
    }),
  ).rejects.toBeInstanceOf(WorkflowNondeterminismError)
})

test('setTimeout() throws in strict mode when called from workflow code', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('timeoutWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => {
        setTimeout(() => {}, 1)
        return 'ok'
      }),
    ),
  )

  await expect(execute(executor, { workflowType: 'timeoutWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('setInterval() throws in strict mode when called from workflow code', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('intervalWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => {
        setInterval(() => {}, 1)
        return 'ok'
      }),
    ),
  )

  await expect(execute(executor, { workflowType: 'intervalWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('performance.now() throws in strict mode when called from workflow code', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('performanceNowWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => performance.now()),
    ),
  )

  await expect(execute(executor, { workflowType: 'performanceNowWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('WebSocket constructor throws in strict mode when called from workflow code when available', async () => {
  const WebSocketRef = (globalThis as unknown as { WebSocket?: new (...args: unknown[]) => unknown }).WebSocket
  if (typeof WebSocketRef !== 'function') {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('websocketWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => new WebSocketRef('ws://example.invalid')),
    ),
  )

  await expect(execute(executor, { workflowType: 'websocketWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('WebSocket guard preserves constructor prototype and static members when available', () => {
  installWorkflowRuntimeGuards({ mode: 'strict' })
  const globalRef = globalThis as unknown as Record<symbol, unknown>
  const original = globalRef[Symbol.for('@proompteng/temporal-bun-sdk.original.WebSocket')] as
    | (Function & { prototype?: unknown; OPEN?: unknown })
    | undefined
  const patched = (globalThis as unknown as { WebSocket?: Function & { prototype?: unknown; OPEN?: unknown } }).WebSocket
  if (!original || !patched) return

  expect(patched.prototype).toBe(original.prototype)
  expect(Object.getPrototypeOf(patched)).toBe(original)
  expect(patched.OPEN).toBe(original.OPEN)
})

test('Bun.spawn() throws in strict mode when called from workflow code', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunSpawnWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => {
        Bun.spawn(['true'])
        return 'ok'
      }),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunSpawnWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('Bun.nanoseconds() throws in strict mode when called from workflow code when available', async () => {
  const bunRef = (globalThis as unknown as { Bun?: { nanoseconds?: () => number } }).Bun
  if (typeof bunRef?.nanoseconds !== 'function') {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunNanosecondsWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => bunRef.nanoseconds?.()),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunNanosecondsWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('Bun.sleep() throws in strict mode when called from workflow code when available', async () => {
  const bunRef = (globalThis as unknown as { Bun?: BunRuntimeForGuardTests }).Bun
  if (typeof bunRef?.sleep !== 'function') {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunSleepWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.tryPromise(() => bunRef.sleep?.(0) ?? Promise.resolve()),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunSleepWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('Bun.file() throws in strict mode when called from workflow code when available', async () => {
  const bunRef = (globalThis as unknown as { Bun?: BunRuntimeForGuardTests }).Bun
  if (typeof bunRef?.file !== 'function') {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunFileWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => bunRef.file?.('/tmp/temporal-bun-sdk-runtime-guard-probe')),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunFileWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('Bun.write() throws in strict mode when called from workflow code when available', async () => {
  const bunRef = (globalThis as unknown as { Bun?: BunRuntimeForGuardTests }).Bun
  if (typeof bunRef?.write !== 'function') {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunWriteWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => bunRef.write?.('/tmp/temporal-bun-sdk-runtime-guard-probe', 'x')),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunWriteWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('Bun.connect() throws in strict mode when called from workflow code when available', async () => {
  const bunRef = (globalThis as unknown as { Bun?: BunRuntimeForGuardTests }).Bun
  if (typeof bunRef?.connect !== 'function') {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunConnectWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() =>
        bunRef.connect?.({
          hostname: '127.0.0.1',
          port: 1,
          socket: {},
        }),
      ),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunConnectWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('Bun.serve() throws in strict mode when called from workflow code when available', async () => {
  const bunRef = (globalThis as unknown as { Bun?: BunRuntimeForGuardTests }).Bun
  if (typeof bunRef?.serve !== 'function') {
    return
  }

  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('bunServeWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => {
        const server = bunRef.serve?.({
          port: 0,
          fetch: () => new Response('ok'),
        })
        server?.stop?.()
        return 'ok'
      }),
    ),
  )

  await expect(execute(executor, { workflowType: 'bunServeWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})
