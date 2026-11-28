import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, Result } from 'effect'

import { jevEvaluationCommand, jevEvaluationCommandUsage } from './jev-evaluation-command'

test('offline evaluator rejects paid verification before acquiring provider credentials', async () => {
  let configurationReads = 0
  const provider = ConfigProvider.make(() =>
    Effect.sync(() => {
      configurationReads++
      return undefined
    }),
  )
  const result = await Effect.runPromise(
    jevEvaluationCommand(['--verify-box']).pipe(
      Effect.result,
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.provide(NodeServices.layer),
    ),
  )

  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe('JevContractError')
    expect(result.failure.message).toBe(jevEvaluationCommandUsage)
  }
  expect(configurationReads).toBe(0)
})
