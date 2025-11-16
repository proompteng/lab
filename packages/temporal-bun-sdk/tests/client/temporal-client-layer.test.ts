import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'

import { makeTemporalClientEffect } from '../../src/client'
import { createConfigLayer, createObservabilityLayer, createWorkflowServiceLayer } from '../../src/runtime/effect-layers'

const ConfigTestLayer = createConfigLayer({
  defaults: {
    address: '127.0.0.1:7233',
    namespace: 'default',
    taskQueue: 'prix',
  },
})

const ClientTestLayer = Layer.mergeAll(ConfigTestLayer, createObservabilityLayer(), createWorkflowServiceLayer())

describe('makeTemporalClientEffect', () => {
  test('builds a client when layers are provided', async () => {
    const effect = makeTemporalClientEffect()
    const result = await Effect.runPromise(effect.pipe(Effect.provideLayer(ClientTestLayer)))

    expect(result.config.namespace).toBe('default')
    await result.client.shutdown()
  })
})
