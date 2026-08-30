import { describe, expect, test } from 'bun:test'
import { TemporalConfigError } from '../../src/config'
import { buildTemporalConfigEffect } from '../../src/runtime/config-layer'
import { runEffect } from '../helpers/effect'

const baseEnv = {
  TEMPORAL_ADDRESS: '127.0.0.1:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: 'replay-fixtures',
}

describe('config layer effect', () => {
  test('applies overrides after loading config', async () => {
    const config = await runEffect(
      buildTemporalConfigEffect({
        env: baseEnv,
        overrides: {
          namespace: 'override',
          taskQueue: 'custom-queue',
        },
        warnOnMissingEnv: [],
      }),
    )

    expect(config.namespace).toBe('override')
    expect(config.taskQueue).toBe('custom-queue')
  })

  test('propagates schema failures as TemporalConfigError', async () => {
    await expect(
      runEffect(
        buildTemporalConfigEffect({
          env: {
            ...baseEnv,
            TEMPORAL_GRPC_PORT: 'NaN',
          },
          warnOnMissingEnv: [],
        }),
      ),
    ).rejects.toThrow(TemporalConfigError)
  })
})
