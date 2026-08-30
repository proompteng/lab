import { describe, expect, test } from 'bun:test'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Effect, Layer } from 'effect'

import { makeTemporalClientEffect } from '../../src/client'
import { createConfigLayer, createObservabilityLayer, createWorkflowServiceLayer } from '../../src/runtime/effect-layers'
import type { InterceptorBuilder } from '../../src/client/interceptors'

const ConfigTestLayer = createConfigLayer({
  defaults: {
    address: '127.0.0.1:7233',
    namespace: 'default',
    taskQueue: 'replay-fixtures',
  },
})

const ObservabilityLayer = createObservabilityLayer().pipe(Layer.provide(ConfigTestLayer))
const WorkflowLayer = createWorkflowServiceLayer()
  .pipe(Layer.provide(ConfigTestLayer))
  .pipe(Layer.provide(ObservabilityLayer))
const ClientTestLayer = Layer.mergeAll(ConfigTestLayer, ObservabilityLayer, WorkflowLayer)

describe('makeTemporalClientEffect', () => {
  test('builds a client when layers are provided', async () => {
    const effect = makeTemporalClientEffect()
    const result = await Effect.runPromise(Effect.provide(effect, ClientTestLayer))

    expect(result.config.namespace).toBe('default')
    await result.client.shutdown()
  })

  test('reuses caller provided transport without rebuilding interceptors', async () => {
    const customTransport = createGrpcTransport({
      baseUrl: 'http://127.0.0.1:7233',
    })

    let interceptorBuilds = 0
    const throwingBuilder: InterceptorBuilder = {
      build() {
        interceptorBuilds += 1
        return Effect.fail(new Error('interceptor builder should not run'))
      },
    }

    const effect = makeTemporalClientEffect({
      transport: customTransport,
      interceptorBuilder: throwingBuilder,
    })

    const result = await Effect.runPromise(Effect.provide(effect, ClientTestLayer))

    expect(interceptorBuilds).toBe(0)
    expect((result.client as Record<string, unknown>).transport).toBe(customTransport)
    await result.client.shutdown()
  })
})
