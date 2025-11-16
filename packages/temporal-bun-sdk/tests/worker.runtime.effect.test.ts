import { describe, expect, test } from 'bun:test'
import { createClient } from '@connectrpc/connect'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { createConfigLayer, createObservabilityLayer, WorkflowServiceClientService } from '../src/runtime/effect-layers'
import { makeWorkerRuntimeEffect } from '../src/worker/layer'
import type { PollActivityTaskQueueResponse, PollWorkflowTaskQueueResponse } from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from '../src/proto/temporal/api/workflowservice/v1/service_pb'
import { defineWorkflow } from '../src/workflow/definition'

const createStubWorkflowService = () => {
  const stats = { workflowPolls: 0, activityPolls: 0 }

  const stub = new Proxy(
    {},
    {
      get: (target, prop: string | symbol) => {
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop)
        }
        if (prop === 'pollWorkflowTaskQueue') {
          return async (): Promise<PollWorkflowTaskQueueResponse> => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            stats.workflowPolls += 1
            return {}
          }
        }
        if (prop === 'pollActivityTaskQueue') {
          return async (): Promise<PollActivityTaskQueueResponse> => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            stats.activityPolls += 1
            return {}
          }
        }
        return async () => {
          throw new Error(`Unexpected WorkflowService call: ${String(prop)}`)
        }
      },
    },
  ) as ReturnType<typeof createClient<typeof WorkflowService>>

  return { service: stub, stats }
}

describe('runWorkerEffect', () => {
  test('supervises worker runtime inside Effect scope', async () => {
    const { service, stats } = createStubWorkflowService()
    const configLayer = createConfigLayer({
      defaults: {
        address: '127.0.0.1:7233',
        namespace: 'default',
        taskQueue: 'prix',
      },
    })
    const observabilityLayer = createObservabilityLayer().pipe(Layer.provide(configLayer))
    const layer = Layer.mergeAll(
      configLayer,
      observabilityLayer,
      Layer.succeed(WorkflowServiceClientService, service),
    )

    const workflows = [defineWorkflow('noop', () => Effect.void)]

    const env = ManagedRuntime.make(layer)
    try {
      const runtime = await env.runPromise(
        makeWorkerRuntimeEffect({
          taskQueue: 'prix',
          namespace: 'default',
          workflows,
          activities: {},
          stickyScheduling: false,
          concurrency: { workflow: 1 },
        }),
      )

      expect(runtime).toHaveProperty('run')
      expect(runtime).toHaveProperty('shutdown')
    } finally {
      await env.dispose().catch(() => undefined)
    }

    expect(stats.workflowPolls).toBe(0)
    expect(stats.activityPolls).toBe(0)
  })
})
