import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit } from 'effect'
import * as Chunk from 'effect/Chunk'

import { loadTemporalConfigEffect, TemporalConfigError } from '../../src/config'

const baseEnv: NodeJS.ProcessEnv = {
  TEMPORAL_TASK_QUEUE: 'test-queue',
  TEMPORAL_NAMESPACE: 'default',
}

describe('loadTemporalConfigEffect', () => {
  test('fails when TEMPORAL_GRPC_PORT is invalid', async () => {
    const exit = await Effect.runPromiseExit(
      loadTemporalConfigEffect({
        env: {
          ...baseEnv,
          TEMPORAL_GRPC_PORT: 'http',
        },
      }),
    )
    expectTemporalConfigErrorExit(exit)
  })

  test('fails when TLS certificate paths are incomplete', async () => {
    const exit = await Effect.runPromiseExit(
      loadTemporalConfigEffect({
        env: {
          ...baseEnv,
          TEMPORAL_TLS_CERT_PATH: '/tmp/cert.pem',
        },
      }),
    )
    expectTemporalConfigErrorExit(exit)
  })
})

const expectTemporalConfigErrorExit = (exit: Exit.Exit<unknown, unknown>) => {
  expect(exit._tag).toBe('Failure')
  const failures = Chunk.toReadonlyArray(Cause.failures(exit.cause))
  expect(failures.length).toBeGreaterThan(0)
  expect(failures[0]).toBeInstanceOf(TemporalConfigError)
}
