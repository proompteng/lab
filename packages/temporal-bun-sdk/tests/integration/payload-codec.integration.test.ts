import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { Effect, Exit } from 'effect'
import * as Schema from 'effect/Schema'

import { createTemporalClient } from '../../src/client'
import { loadTemporalConfig } from '../../src/config'
import { WorkerRuntime } from '../../src/worker/runtime'
import { defineWorkflow, defineWorkflowUpdates } from '../../src/workflow/definition'
import { defineWorkflowQueries } from '../../src/workflow/inbound'
import {
  TemporalCliUnavailableError,
  createIntegrationHarness,
  type IntegrationHarness,
} from './harness'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip
const hookTimeoutMs = 60_000
const TASK_QUEUE = `codec-e2e-${Date.now()}`
const AES_KEY = Buffer.alloc(32, 11).toString('base64')

const CLI_CONFIG = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
}

const codecUpdateDefinitions = defineWorkflowUpdates([
  {
    name: 'codec.setMessage',
    input: Schema.Struct({ value: Schema.String }),
  },
])

const codecQueryDefinitions = defineWorkflowQueries({
  'codec.message': {
    input: Schema.Struct({}),
    output: Schema.Struct({
      message: Schema.String,
      payload: Schema.Struct({ nested: Schema.String, count: Schema.Number }),
      echoed: Schema.Boolean,
    }),
  },
})

const codecWorkflow = defineWorkflow(
  'codecPayloadWorkflow',
  Schema.Struct({
    initial: Schema.String,
    payload: Schema.Struct({ nested: Schema.String, count: Schema.Number }),
  }),
  ({ activities, updates, queries, timers, input }) =>
    Effect.gen(function* () {
      let state = { message: input.initial, payload: input.payload, echoed: false as boolean }
      let latestMessage = state.message
      let latestPayload = state.payload
      let wasUpdated = false

      const [setMessageDef] = codecUpdateDefinitions
      updates.register(setMessageDef, (_ctx, payload: { value: string }) =>
        Effect.sync(() => {
          state = { ...state, message: payload.value }
          latestMessage = payload.value
          wasUpdated = true
          return { ok: true }
        }),
      )

      queries.register(codecQueryDefinitions['codec.message'], () => Effect.sync(() => state))

      const echoed = (yield* activities.schedule('codecEchoActivity', [state])) as typeof state
      // Preserve updated message while adopting echoed payload fields.
      state = {
        ...state,
        payload: echoed.payload,
        echoed: true,
      }

      // Give the update path time to run before completing.
      yield* timers.start({ timeoutMs: 500 })
      return { message: latestMessage, payload: latestPayload, echoed: true }
    }),
  { updates: codecUpdateDefinitions, queries: codecQueryDefinitions },
)

const codecActivities = {
  codecEchoActivity: async <T>(input: T) => input,
}

describeIntegration('payload codec E2E', () => {
  let harness: IntegrationHarness | null = null
  let runtime: WorkerRuntime | null = null
  let runtimePromise: Promise<void> | null = null
  let cliUnavailable = false
  let temporalClient: Awaited<ReturnType<typeof createTemporalClient>>['client'] | null = null
  let configDefaults = null as Awaited<ReturnType<typeof loadTemporalConfig>> | null

  beforeAll(async () => {
    const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(CLI_CONFIG))
    if (Exit.isFailure(harnessExit)) {
      if (harnessExit.cause instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping codec integration: ${harnessExit.cause.message}`)
        return
      }
      throw harnessExit.cause
    }
    harness = harnessExit.value
    await Effect.runPromise(harness.setup)

    const payloadCodecs = [
      { name: 'gzip' as const },
      { name: 'aes-gcm' as const, key: AES_KEY, keyId: 'codec-e2e' },
    ]

    const config = await loadTemporalConfig({
      defaults: {
        address: CLI_CONFIG.address,
        namespace: CLI_CONFIG.namespace,
        taskQueue: TASK_QUEUE,
        payloadCodecs,
      },
    })
    configDefaults = config
    runtime = await WorkerRuntime.create({
      config,
      workflows: [codecWorkflow],
      activities: codecActivities,
      taskQueue: TASK_QUEUE,
      namespace: config.namespace,
      stickyScheduling: false,
    })
    runtimePromise = runtime.run().catch((error) => {
      console.error('[temporal-bun-sdk] codec runtime exited', error)
      throw error
    })

    const { client } = await createTemporalClient({
      config,
      taskQueue: TASK_QUEUE,
      namespace: config.namespace,
    })
    temporalClient = client
  }, { timeout: hookTimeoutMs })

  afterAll(async () => {
    if (temporalClient) {
      await temporalClient.shutdown().catch(() => {})
    }
    if (runtime) {
      await runtime.shutdown().catch(() => {})
    }
    if (runtimePromise) {
      await runtimePromise.catch(() => {})
    }
    if (harness) {
      await Effect.runPromise(harness.teardown)
    }
  }, { timeout: hookTimeoutMs })

  test('codecs wrap workflow, activity, query, and update payloads', async () => {
    if (cliUnavailable || !temporalClient || !configDefaults) {
      expect(true).toBeTrue()
      return
    }
    const workflowId = `codec-wf-${crypto.randomUUID()}`
    const start = await temporalClient.startWorkflow({
      workflowId,
      workflowType: 'codecPayloadWorkflow',
      taskQueue: TASK_QUEUE,
      args: [
        {
          initial: 'hello-codec',
          payload: { nested: 'value', count: 3 },
        },
      ],
      memo: { env: 'codec-e2e' },
    })

    const handle = start.handle
    const updateResult = await temporalClient.updateWorkflow(handle, {
      updateName: 'codec.setMessage',
      args: [{ value: 'updated-codec' }],
      waitForStage: 'completed',
    })
    expect(updateResult.outcome?.status).toBe('success')

    // Query state after update to verify payloads flowed through codecs.
    const queryResult = (await temporalClient.workflow.query(handle, 'codec.message')) as {
      message: string
      payload: { nested: string; count: number }
      echoed: boolean
    }
    expect(queryResult).toEqual({ message: 'updated-codec', payload: { nested: 'value', count: 3 }, echoed: true })

    // Wait for workflow completion to ensure activity + update payloads flowed through codecs.
    const result = await temporalClient.workflow.result(handle)
    expect(result.payload).toEqual({ nested: 'value', count: 3 })
    expect(result.echoed).toBeTrue()
  }, 90_000)
})
