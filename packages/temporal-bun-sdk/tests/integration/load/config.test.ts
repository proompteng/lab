import { expect, test } from 'bun:test'

import { readWorkerLoadConfig } from './config'

test('worker load config reads restart and sticky TTL failure-injection controls', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_RESTART_AFTER_SUBMIT: '1',
      TEMPORAL_LOAD_TEST_RESTART_DELAY_MS: '250',
      TEMPORAL_LOAD_TEST_STICKY_TTL_MS: '1000',
      TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_RATIO: '0.75',
      TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_DELAY_MS: '125',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.restartAfterSubmit).toBeTrue()
      expect(config.restartDelayMs).toBe(250)
      expect(config.stickyTtlMs).toBe(1000)
      expect(config.activityCancellationRatio).toBe(0.75)
      expect(config.activityCancellationDelayMs).toBe(125)
    },
  )
})

const withEnvironment = async <A>(env: Record<string, string | undefined>, action: () => Promise<A>): Promise<A> => {
  const snapshot = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    snapshot.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return await action()
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
