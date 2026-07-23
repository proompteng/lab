import { describe, expect, test } from 'bun:test'

import { Cause, Clock, Effect, Exit } from 'effect'

import {
  config,
  fixtureEvaluation,
  fixtureStrategy,
  marketDataService,
  pinnedEvaluation,
  pinnedRuntimeConfig,
  pinnedStore,
  successfulEvidenceStore,
  successfulJournal,
} from './app-test-support'
import { run, type AutonomousCycleStartupInput } from './app'
import { makeStrategyProtocolHash } from './contracts'
import { CycleObservability } from './db/cycle-observability'
import { EvidenceStore } from './db/evidence-store'
import { operationalError } from './errors'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { makeStrategy } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

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
    let startupQualificationRunId: string | undefined
    let startupStrategyProtocolHash: string | undefined
    const autonomousCycleStartup = ({
      qualificationRunId,
      strategyProtocolHash,
      recordPass,
    }: AutonomousCycleStartupInput) =>
      Effect.gen(function* () {
        calls.push('autonomous-cycle')
        startupQualificationRunId = qualificationRunId
        startupStrategyProtocolHash = strategyProtocolHash
        yield* recordPass({
          result: 'SUCCESS',
          observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          outcome: 'NO_PUBLICATION',
        })
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
    expect(startupQualificationRunId).toBe(fixtureEvaluation.runId)
    expect(startupStrategyProtocolHash).toBe(fixtureEvaluation.protocolHash)
    expect(backgroundInterrupted).toBe(true)
  })

  test('keeps the pinned qualification scope separate from the current decision protocol identity', async () => {
    const currentStrategy = makeStrategy(
      fixtureProtocol,
      makeTestProvenance(fixtureProtocol, { behaviorHash: 'c'.repeat(64) }),
    )
    const currentProtocolHash = makeStrategyProtocolHash(currentStrategy.provenance.strategy)
    expect(currentProtocolHash).not.toBe(pinnedEvaluation.protocolHash)

    let startupQualificationRunId: string | undefined
    let startupStrategyProtocolHash: string | undefined
    const autonomousCycleStartup = ({ qualificationRunId, strategyProtocolHash }: AutonomousCycleStartupInput) =>
      Effect.gen(function* () {
        startupQualificationRunId = qualificationRunId
        startupStrategyProtocolHash = strategyProtocolHash
        return yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true }))
      })
    const reconciliation = Effect.sync(() => {
      throw new Error('stop after pinned composition proof')
    })

    const exit = await Effect.runPromiseExit(
      run(pinnedRuntimeConfig, currentStrategy, reconciliation, undefined, autonomousCycleStartup).pipe(
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('pinned startup must not load Signal bars'))),
        ),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, pinnedStore()),
        Effect.provideService(CycleObservability, cycleObservability),
        Effect.timeoutOrElse({
          duration: 1_000,
          orElse: () => Effect.fail(operationalError('http', 'test', 'pinned composition proof remained alive')),
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('stop after pinned composition proof')
    expect(startupQualificationRunId).toBe(pinnedEvaluation.runId)
    expect(startupStrategyProtocolHash).toBe(currentProtocolHash)
    expect(startupStrategyProtocolHash).not.toBe(pinnedEvaluation.protocolHash)
  })
})
