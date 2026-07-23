import { describe, expect, test } from 'bun:test'

import { Cause, Effect, Exit } from 'effect'

import {
  config,
  fixtureStrategy,
  marketDataService,
  successfulEvidenceStore,
  successfulJournal,
} from './app-test-support'
import { run } from './app'
import { CycleObservability } from './db/cycle-observability'
import { EvidenceStore } from './db/evidence-store'
import { operationalError } from './errors'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { makeSnapshot } from './test-fixtures'

const cycleObservability = {
  read: () =>
    Effect.succeed({
      current: null,
      last: null,
      unfinishedCycleCount: 0,
      authority: null,
      reconciliation: null,
      mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
    }),
}

describe('Bayn application composition', () => {
  test('starts one scoped autonomous cycle background after initialization and before reconciliation', async () => {
    const calls: string[] = []
    let backgroundInterrupted = false
    const marketData = marketDataService(
      Effect.sync(() => {
        calls.push('initialize')
        return makeSnapshot()
      }),
    )
    const autonomousCycleStartup = Effect.gen(function* () {
      calls.push('autonomous-cycle')
      const fiber = yield* Effect.never.pipe(
        Effect.onInterrupt(() => Effect.sync(() => void (backgroundInterrupted = true))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Effect.yieldNow
      return fiber
    })
    const reconciliation = Effect.sync(() => {
      calls.push('reconciliation')
      throw new Error('stop after composition proof')
    })

    const exit = await Effect.runPromiseExit(
      run(config, fixtureStrategy, reconciliation, undefined, autonomousCycleStartup).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provideService(CycleObservability, cycleObservability),
        Effect.timeoutOrElse({
          duration: 1_000,
          orElse: () => Effect.fail(operationalError('http', 'test', 'composition proof remained alive')),
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('stop after composition proof')
    expect(calls).toEqual(['initialize', 'autonomous-cycle', 'reconciliation'])
    expect(backgroundInterrupted).toBe(true)
  })
})
