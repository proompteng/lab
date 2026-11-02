import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import { runTemporalCliEffect } from '../../src/runtime/cli-layer'
import { ObservabilityService, TemporalConfigService } from '../../src/runtime/effect-layers'

describe('runTemporalCliEffect', () => {
  test('provides Temporal config defaults through the layer stack', async () => {
    const config = await runTemporalCliEffect(
      Effect.gen(function* () {
        const config = yield* TemporalConfigService
        const { logger } = yield* ObservabilityService
        yield* logger.log('debug', 'cli-layer-defaults', { namespace: config.namespace })
        return config
      }),
      {
        config: {
          defaults: {
            address: '10.1.0.5:7233',
            namespace: 'cli-layer-test',
            taskQueue: 'cli-layer-queue',
          },
          env: {},
        },
      },
    )

    expect(config.address).toBe('10.1.0.5:7233')
    expect(config.namespace).toBe('cli-layer-test')
    expect(config.taskQueue).toBe('cli-layer-queue')
  })

  test('respects env overrides for namespace and task queue', async () => {
    const config = await runTemporalCliEffect(
      Effect.gen(function* () {
        return yield* TemporalConfigService
      }),
      {
        config: {
          env: {
            TEMPORAL_ADDRESS: 'env-override:7233',
            TEMPORAL_NAMESPACE: 'cli-env-namespace',
            TEMPORAL_TASK_QUEUE: 'cli-env-queue',
          },
        },
      },
    )

    expect(config.address).toBe('env-override:7233')
    expect(config.namespace).toBe('cli-env-namespace')
    expect(config.taskQueue).toBe('cli-env-queue')
  })
})
