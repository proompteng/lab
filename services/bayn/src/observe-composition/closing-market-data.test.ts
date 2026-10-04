import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Exit, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, BrokerReadError, BrokerReadErrorKind, type BrokerReadShape } from '../broker/alpaca'
import { CycleState, decodeAutonomousCycle } from '../cycle'
import { Authority, IntentState, KillState, OrderType, TerminalOutcome } from '../execution/contracts'
import { IntentStore, planExecutionIntent, type StoredIntent } from '../execution/intents'
import { MutationStore, type MutationStoreShape } from '../execution/mutations'
import {
  makeExecutionCycleClosure,
  type ExecutionCycleClosure,
  type ExecutionCycleClosureStoreShape,
} from '../db/execution-cycle-closure'
import { ensureExecutionCycleClosure } from './execution-cycle'
import { resolveExecutionCycleCloseWindow } from './execution-window'
import { prepareMutationIntent } from './mutation-intent-interpreter'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { nativeJevBatchResult, nativeJevFixture } from '../jev/native.test-support'
import { JevPositionStore, JevPurpose } from '../jev/portfolio'
import { decideJevExit, JevExitReason } from '../jev/exit'
import { type IntradayMarketDataService, MarketData } from '../market-data'
import { IntradaySnapshotFailure } from '../market-data/intraday/model'
import { retryableOperationalError } from '../errors'
import { reconciledStateHash } from '../reconciliation'
import { type ReconciliationPassResult } from '../reconciler'
import { loadStrategyExecutionRiskPolicy } from '../observe-composition'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { currentUtcInstant } from '../time'
import { CandidateObservationStore } from './candidate-observation'
import { checkAdvancedMarketProjection, closeQuoteContinuationDelayMs } from './recovery-driver'
import { advanceExecutionOnce } from '../execution/advance'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import {
  completeExecutionControllerTick,
  decodeExecutionControllerState,
  decideExecutionControllerActivation,
  decideExecutionControllerTick,
} from '../execution/controller'
import {
  buildMutationShadowCycleDecision,
  ExecutionCloseAwaitingMarketData,
  executionCloseMarketDataDiagnostics,
  prepareClosingExecutionCycleDecision,
} from './decision-builder'
import { prepareObserveStartup } from './startup'

const generationHash = 'b'.repeat(64)
const native = nativeJevFixture()
const accountId = native.portfolio.brokerState.account.accountId
const at = native.query.observedAt
const activeCycle = Effect.runSync(
  decodeAutonomousCycle({
    ...native.draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: at,
    updatedAt: at,
  }),
)

const factsAt = (observedAt: string, held = false): ReconciliationPassResult => {
  const source = held ? nativeJevFixture(JevPurpose.Manage).portfolio.brokerState : native.portfolio.brokerState
  const state = {
    ...source,
    account: { ...source.account, observedAt },
    positions: source.positions.map((position) => ({ ...position, observedAt })),
    positionsObservedAt: observedAt,
    orders: source.orders.map((order) => ({ ...order, observedAt })),
    ordersObservedAt: observedAt,
  }
  const hash = Result.getOrThrow(reconciledStateHash(state))
  const reconciliation = { ...source.reconciliation, reconciledAt: observedAt, expectedHash: hash, observedHash: hash }
  return {
    report: {
      reconciliation,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact: true,
        discrepancyCount: 0,
      },
    },
    brokerState: { ...state, reconciliation },
    riskContext: {
      tradingDate: native.query.sessionDate,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: observedAt,
      },
      authorityObservedAt: observedAt,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: state.account.equityMicros,
      peakEquityMicros: state.account.equityMicros,
    },
  }
}

const unavailable = new IntradaySnapshotFailure({
  reason: 'not-ready',
  message: 'Fixture quote partition has not caught up',
  facts: { symbol: 'AAPL' },
})
const marketFailure = retryableOperationalError({
  component: 'market-data',
  operation: 'snapshot',
  message: 'Fixture archive cut unavailable',
  cause: unavailable,
})
const freshMarket: IntradayMarketDataService = {
  check: Effect.void,
  loadSnapshot: (query) =>
    Effect.sync(
      () =>
        streamingFixtureFromRaw(
          makeIntradayMomentumTestSnapshot(native.protocol, { ...query, archiveWatermarks: [] }, { AAPL: 0.02 }, 10),
          query,
        ).snapshot,
    ),
  verifyReference: fixtureStreamingReference,
}

const fixture = async () => {
  const input = {
    accountId,
    authorityGenerationHash: generationHash,
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy: fixtureRuntime,
    intradayMarketData: freshMarket,
  }
  const preparation = Result.getOrThrow(prepareObserveStartup(input))
  const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, fixtureRuntime))
  const unused = Effect.die(new Error('Unexpected fixture I/O'))
  const broker: BrokerReadShape = {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: () => unused,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    feeActivities: () => unused,
    fillActivities: () => unused,
    marketCalendar: () =>
      Effect.succeed({
        value: native.query.calendar,
        evidence: {
          requestId: 'fixture',
          status: 200,
          contentHash: 'f'.repeat(64),
          observedAt: at,
        },
      }),
  }
  const document = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle: activeCycle,
        executionModel: preparation.executionModel,
        policy,
        reconcile: Effect.succeed(factsAt(at)),
        strategy: fixtureRuntime,
        intradayMarketData: freshMarket,
      })
    }).pipe(
      Effect.provideService(BrokerRead, broker),
      Effect.provideService(MarketData, {
        check: unused,
        load: unused,
        inspect: unused,
        inspectCyclePublications: unused,
        inspectPublication: () => unused,
        inspectSnapshotPublication: () => unused,
        loadSnapshotPublication: () => unused,
      }),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      Effect.provideService(JevBatchStore, {
        read: () => unused,
        pending: () => Effect.succeed([]),
        begin: (plan) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => ({
              plan,
              result: nativeJevBatchResult(plan, new Date(now).toISOString(), (symbol) =>
                symbol === 'AAPL' ? 'enter' : 'wait',
              ),
            })),
          ),
        finish: () => unused,
      }),
      Effect.provideService(JevEvaluationStore, {
        read: () => unused,
        begin: () => unused,
        record: () => unused,
        abandon: () => unused,
      }),
      Effect.provideService(JevClient, { evaluate: () => unused }),
      Effect.provideService(JevPositionStore, { read: () => unused }),
      Effect.provide(TestClock.layer()),
    ),
  )
  return {
    input,
    preparation,
    policy,
    entryDocument: document,
    cycle: Effect.runSync(
      decodeAutonomousCycle({
        ...activeCycle,
        bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
        stateVersion: 2,
        updatedAt: document.createdAt,
      }),
    ),
    closeExpiresAt: activeCycle.window.executionCloseAt,
  }
}

describe('closing market-data fallback boundaries', () => {
  test.each([
    'filled',
    'denied',
    'unknown',
    'inexact-accounting',
    'failed-refresh',
    'invalid-refresh',
    'older-cut',
    'fallback-flat',
    'fallback-flat-exit',
  ] as const)('terminal close uses fresh settlement evidence before another action (%s)', async (scenario) => {
    const fallbackFlat = scenario.startsWith('fallback-flat')
    const request = await fixture()
    const closeWindow = Result.getOrThrow(
      resolveExecutionCycleCloseWindow({
        executionCloseAt: request.closeExpiresAt,
        sessionCloseStartLeadMs: native.protocol.flattenBeforeCloseMinutes * 60_000,
        sessionCloseSubmitLeadMs: native.protocol.hardFlatBeforeCloseMinutes * 60_000,
      }),
    )
    const records = new Map<string, StoredIntent>()
    let closure: ExecutionCycleClosure | undefined
    let retainedReplan: ExecutionCycleClosure | undefined
    let residualBinds = 0
    let freshReads = 0
    const store: ExecutionCycleClosureStoreShape = {
      read: () => Effect.sync(() => Option.fromUndefinedOr(closure)),
      readLatestReplan: () => Effect.sync(() => Option.fromUndefinedOr(retainedReplan)),
      bind: (value) =>
        Effect.sync(() => {
          closure = value
          return value
        }),
      bindReplan: (value) =>
        Effect.sync(() => {
          residualBinds += 1
          return value
        }),
      containsIntent: () => Effect.succeed(true),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(closeWindow.startAt) + 1_000)
        const before = yield* currentUtcInstant
        const exitTarget =
          scenario === 'fallback-flat-exit'
            ? Result.getOrThrow(
                decideJevExit({
                  cycleId: request.cycle.identity.cycleId,
                  sessionDate: request.cycle.identity.executionSessionDate,
                  protocol: native.protocol,
                  portfolio: {
                    ...nativeJevFixture(JevPurpose.Manage).portfolio,
                    entryDecisionHash: request.entryDocument.contentHash,
                    brokerState: factsAt(before, true).brokerState,
                  },
                  observedAt: before,
                  trigger: { reason: JevExitReason.MaximumHold },
                }),
              )
            : undefined
        const initial = yield* ensureExecutionCycleClosure({
          ...request,
          input: { ...request.input, executionCycleClosureStore: store },
          closeWindow,
          reconcile: Effect.succeed(factsAt(before, true)),
          refreshReconciliation: Effect.die('an uncommitted close has no terminal evidence to refresh'),
          existing: undefined,
          ...(exitTarget === undefined ? {} : { exitTarget }),
        })
        if (initial._tag !== 'Close' || closure === undefined) throw new Error('missing committed close fixture')
        if (exitTarget !== undefined) expect(initial.document.strategyDecision).toEqual(exitTarget)
        yield* TestClock.adjust(1_000)
        const terminalAt = yield* currentUtcInstant
        if (scenario === 'denied') {
          const replan = yield* prepareClosingExecutionCycleDecision({
            ...request,
            reconcile: Effect.succeed(factsAt(terminalAt, true)),
            initialReconciliation: factsAt(terminalAt, true),
            replanGenerationHash: closure.contentHash,
          })
          retainedReplan = yield* Effect.fromResult(
            makeExecutionCycleClosure({
              schemaVersion: 'bayn.paper-cycle-closure.v1',
              cycleId: request.cycle.identity.cycleId,
              entryDecisionHash: request.entryDocument.contentHash,
              document: replan.document,
              createdAt: replan.document.createdAt,
              expiresAt: request.closeExpiresAt,
            }),
          )
        }
        for (const [document, terminalOutcome] of [
          [request.entryDocument, TerminalOutcome.Filled],
          [initial.document, TerminalOutcome.Filled],
          ...(retainedReplan === undefined ? [] : [[retainedReplan.document, TerminalOutcome.Rejected] as const]),
        ] as const) {
          const authority = factsAt(document.createdAt).riskContext.authority
          if (authority === null) throw new Error('missing fixture authority')
          for (const [index, target] of document.targetPlan.intentTargets.entries()) {
            const risk = document.deltaRisk[index]
            if (risk === undefined) throw new Error('missing fixture risk binding')
            const intent = yield* planExecutionIntent(
              {
                schemaVersion: 'bayn.paper-intent-plan.v1',
                ...target,
                notionalLimitMicros: risk.notionalLimitMicros,
                ...(document.replanGenerationHash === undefined
                  ? {}
                  : { replanGenerationHash: document.replanGenerationHash }),
                createdAt: document.createdAt,
              },
              { authority },
            )
            records.set(intent.intentId, {
              intent: {
                ...intent,
                state: IntentState.Terminal,
                terminalOutcome,
                riskDecisionId: risk.evaluation.decision.decisionId,
              },
              decision: risk.evaluation.decision,
              stateVersion: 5,
              updatedAt: terminalAt,
            })
          }
        }
        const expectedIntentCount = scenario === 'denied' ? 3 : 2
        expect(records.size).toBe(expectedIntentCount)
        const fresh = factsAt(scenario === 'older-cut' ? before : terminalAt)
        const refreshReconciliation = Effect.suspend(() => {
          freshReads += 1
          if (fallbackFlat && freshReads <= 4 && freshReads % 2 === 1) return Effect.succeed(factsAt(terminalAt, true))
          if (scenario === 'failed-refresh' || scenario === 'invalid-refresh')
            return Effect.fail(
              new BrokerReadError({
                operation: 'preflight',
                kind:
                  scenario === 'failed-refresh' ? BrokerReadErrorKind.Transport : BrokerReadErrorKind.InvalidResponse,
                message: 'synthetic terminal-close refresh unavailable',
                retryable: scenario === 'failed-refresh',
              }),
            )
          return Effect.succeed(
            scenario === 'inexact-accounting'
              ? { ...fresh, report: { ...fresh.report, metrics: { ...fresh.report.metrics, accountingExact: false } } }
              : scenario === 'unknown'
                ? { ...fresh, riskContext: { ...fresh.riskContext, unknownMutationCount: 1 } }
                : fresh,
          )
        })
        const recoverClose = ensureExecutionCycleClosure({
          ...request,
          input: {
            ...request.input,
            executionCycleClosureStore: store,
            ...(fallbackFlat
              ? { intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) } }
              : {}),
          },
          closeWindow,
          reconcile: Effect.succeed(factsAt(before, true)),
          refreshReconciliation,
          existing: closure,
        })
        for (let pass = 0; pass < (fallbackFlat ? 3 : 2); pass++) {
          const result = yield* Effect.exit(recoverClose)
          if (scenario === 'invalid-refresh') expect(Exit.isFailure(result)).toBe(true)
          else {
            if (Exit.isFailure(result)) throw new Error('terminal close fixture unexpectedly failed')
            expect(result.value._tag).toBe(
              scenario === 'filled' || scenario === 'denied' || (fallbackFlat && pass === 2) ? 'Complete' : 'Wait',
            )
          }
          expect(freshReads).toBe(fallbackFlat ? Math.min((pass + 1) * 2, 5) : pass + 1)
          expect(residualBinds).toBe(0)
          expect(records.size).toBe(expectedIntentCount)
        }
      }).pipe(
        Effect.provideService(IntentStore, {
          read: (id) => Effect.sync(() => Option.fromUndefinedOr(records.get(id))),
          commit: () => Effect.die('terminal close must not commit another intent'),
          commitClosing: () => Effect.die('terminal close must not commit another close'),
        }),
        Effect.provideService(MutationStore, { latest: () => Effect.void } as unknown as MutationStoreShape),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test.each([
    'expiry',
    'partial fill',
    'partial fill without archive',
    'fallback becomes unknown',
    'fallback loses accounting',
    'fallback becomes older',
    'fallback regresses after settlement',
    'fallback read fails',
    'fallback read is invalid',
  ] as const)('residual close uses fresh remaining exposure after %s', async (scenario) => {
    const terminalOutcome = scenario === 'expiry' ? TerminalOutcome.Expired : TerminalOutcome.Canceled
    const unavailableArchive = scenario !== 'expiry' && scenario !== 'partial fill'
    const request = await fixture()
    const closeWindow = Result.getOrThrow(
      resolveExecutionCycleCloseWindow({
        executionCloseAt: request.closeExpiresAt,
        sessionCloseStartLeadMs: native.protocol.flattenBeforeCloseMinutes * 60_000,
        sessionCloseSubmitLeadMs: native.protocol.hardFlatBeforeCloseMinutes * 60_000,
      }),
    )
    const records = new Map<string, StoredIntent>()
    let closure: ExecutionCycleClosure | undefined
    let replan: ExecutionCycleClosure | undefined
    let closeCommits = 0
    let restrictions = 0
    let closeSettled = false
    const store: ExecutionCycleClosureStoreShape = {
      read: () => Effect.sync(() => Option.fromUndefinedOr(closure)),
      readLatestReplan: () => Effect.sync(() => Option.fromUndefinedOr(replan)),
      bind: (value) =>
        Effect.sync(() => {
          closure = value
          return value
        }),
      bindReplan: (value) =>
        Effect.sync(() => {
          replan = value
          return value
        }),
      containsIntent: (id) =>
        Effect.sync(() =>
          [...(closure?.document.orderedIntentIds ?? []), ...(replan?.document.orderedIntentIds ?? [])].includes(id),
        ),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(closeWindow.startAt) + 1_000)
        const reconcile = Effect.gen(function* () {
          const facts = factsAt(yield* currentUtcInstant, true)
          if (!closeSettled || terminalOutcome !== TerminalOutcome.Canceled) return facts
          const positions = facts.brokerState.positions.map((position) => ({
            ...position,
            quantityMicros: (BigInt(position.quantityMicros) / 2n).toString(),
            marketValueMicros: (BigInt(position.marketValueMicros) / 2n).toString(),
          }))
          const releasedValue = facts.brokerState.positions.reduce(
            (sum, position) => sum + BigInt(position.marketValueMicros) / 2n,
            0n,
          )
          const state = {
            ...facts.brokerState,
            positions,
            account: {
              ...facts.brokerState.account,
              cashMicros: (BigInt(facts.brokerState.account.cashMicros) + releasedValue).toString(),
              buyingPowerMicros: (BigInt(facts.brokerState.account.buyingPowerMicros) + releasedValue).toString(),
            },
          }
          const hash = Result.getOrThrow(reconciledStateHash(state))
          const reconciliation = { ...state.reconciliation, expectedHash: hash, observedHash: hash }
          return { ...facts, brokerState: { ...state, reconciliation }, report: { ...facts.report, reconciliation } }
        })
        const prepare = (document: NonNullable<typeof closure>['document']) =>
          prepareMutationIntent(
            {
              accountId,
              authorityGenerationHash: generationHash,
              mutationPhase: 'CLOSE',
              executionCycleCloseSubmitCutoffAt: closeWindow.submitCutoffAt,
              executionCycleCloseExpiresAt: closeWindow.expiresAt,
            },
            request.preparation,
            request.policy,
            request.cycle,
            document,
            reconcile,
            true,
            false,
            {
              now: currentUtcInstant,
              readFacts: () =>
                Effect.gen(function* () {
                  const evaluatedAt = yield* currentUtcInstant
                  const reconciliation = yield* reconcile
                  const authority = reconciliation.riskContext.authority
                  if (authority === null) throw new Error('missing existing close authority')
                  return {
                    snapshot: {
                      contentHash: document.bindings.snapshotContentHash,
                      finalizedAt: document.bindings.snapshotFinalizedAt,
                    },
                    reconciliation,
                    authority,
                    evaluatedAt,
                  }
                }),
              restrictAuthority: () =>
                Effect.sync(() => {
                  restrictions += 1
                }),
            },
          )
        const first = yield* ensureExecutionCycleClosure({
          ...request,
          input: { ...request.input, executionCycleClosureStore: store },
          closeWindow,
          reconcile,
          refreshReconciliation: reconcile,
          existing: undefined,
        })
        if (first._tag !== 'Close') throw new Error('fresh owned position should produce a close')
        const selected = yield* prepare(first.document)
        expect(selected).toMatchObject({
          _tag: 'Execute',
          action: 'SUBMIT',
          intentId: first.document.orderedIntentIds[0],
        })
        expect(closeCommits).toBe(1)
        const prior = records.get(first.document.orderedIntentIds[0] ?? '')
        if (prior === undefined || closure === undefined) throw new Error('missing first committed close')
        records.set(prior.intent.intentId, {
          ...prior,
          intent: { ...prior.intent, state: IntentState.Terminal, terminalOutcome },
          stateVersion: prior.stateVersion + 1,
          updatedAt: new Date(Date.parse(first.document.createdAt) + 1_000).toISOString(),
        })
        closeSettled = true
        const expiredAt = first.document.deltaRisk[0]?.evaluation.decision.expiresAt
        if (expiredAt === undefined) throw new Error('missing original close risk deadline')
        yield* TestClock.setTime(Date.parse(first.document.createdAt) + 2_000)
        expect(Date.parse(yield* currentUtcInstant)).toBeLessThan(Date.parse(expiredAt))
        const stale = yield* prepare(first.document)
        expect(stale).toMatchObject({ _tag: 'Wait', waitReason: 'intent-unsuccessful' })
        expect(closeCommits).toBe(1)
        let unstableFallback = scenario.startsWith('fallback')
        let residualReads = 0
        const refreshResidual = reconcile.pipe(
          Effect.flatMap((facts) => {
            residualReads += 1
            if (!unstableFallback || residualReads % 2 === 1) return Effect.succeed(facts)
            if (scenario === 'fallback read fails' || scenario === 'fallback read is invalid')
              return Effect.fail(
                new BrokerReadError({
                  operation: 'preflight',
                  kind:
                    scenario === 'fallback read fails'
                      ? BrokerReadErrorKind.Timeout
                      : BrokerReadErrorKind.InvalidResponse,
                  message: 'synthetic residual fallback read failure',
                  retryable: scenario === 'fallback read fails',
                }),
              )
            if (scenario === 'fallback becomes unknown')
              return Effect.succeed({ ...facts, riskContext: { ...facts.riskContext, unknownMutationCount: 1 } })
            if (scenario === 'fallback loses accounting')
              return Effect.succeed({
                ...facts,
                report: { ...facts.report, metrics: { ...facts.report.metrics, accountingExact: false } },
              })
            return Effect.succeed(
              factsAt(
                scenario === 'fallback regresses after settlement'
                  ? new Date(Date.parse(first.document.createdAt) + 1_000).toISOString()
                  : first.document.createdAt,
                true,
              ),
            )
          }),
        )
        const recoverResidual = ensureExecutionCycleClosure({
          ...request,
          input: {
            ...request.input,
            executionCycleClosureStore: store,
            ...(unavailableArchive
              ? { intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) } }
              : {}),
          },
          closeWindow,
          reconcile: Effect.succeed(factsAt(first.document.createdAt, unavailableArchive)),
          refreshReconciliation: refreshResidual,
          existing: closure,
        })
        if (scenario === 'fallback read is invalid') {
          expect(Exit.isFailure(yield* Effect.exit(recoverResidual))).toBe(true)
          expect(replan).toBeUndefined()
          expect(closeCommits).toBe(1)
          unstableFallback = false
        }
        let next = yield* recoverResidual
        if (unstableFallback) {
          expect(next._tag).toBe('Wait')
          expect(replan).toBeUndefined()
          expect(closeCommits).toBe(1)
          expect((yield* recoverResidual)._tag).toBe('Wait')
          expect(replan).toBeUndefined()
          unstableFallback = false
          next = yield* recoverResidual
        }
        if (next._tag !== 'Close') throw new Error('remaining owned position should produce a residual replan')
        expect(next.document.replanGenerationHash).toBe(closure.contentHash)
        expect(next.document.bindings.authorityGenerationHash).toBe(first.document.bindings.authorityGenerationHash)
        expect(next.document.orderedIntentIds).not.toEqual(first.document.orderedIntentIds)
        expect(
          next.document.targetPlan.intentTargets.map(({ symbol, side, quantityMicros }) => ({
            symbol,
            side,
            quantityMicros,
          })),
        ).toEqual(
          first.document.targetPlan.intentTargets.map(({ symbol, side, quantityMicros }) => ({
            symbol,
            side,
            quantityMicros:
              terminalOutcome === TerminalOutcome.Canceled ? (BigInt(quantityMicros) / 2n).toString() : quantityMicros,
          })),
        )
        expect(yield* prepare(next.document)).toMatchObject({
          _tag: 'Execute',
          action: 'SUBMIT',
          intentId: next.document.orderedIntentIds[0],
        })
        expect(closeCommits).toBe(2)
        expect(restrictions).toBe(1)
        yield* TestClock.setTime(Date.parse(closeWindow.expiresAt))
        expect(yield* prepare(next.document)).toMatchObject({
          _tag: 'Block',
          reason: 'BLOCKED_MISSED_SUBMISSION_DEADLINE',
        })
        expect(closeCommits).toBe(2)
      }).pipe(
        Effect.provideService(IntentStore, {
          read: (id) => Effect.sync(() => Option.fromUndefinedOr(records.get(id))),
          commit: () => Effect.die(new Error('residual close cannot use entry commit authority')),
          commitClosing: (intent, decision) =>
            Effect.sync(() => {
              closeCommits += 1
              const record: StoredIntent = {
                intent: { ...intent, state: IntentState.Approved, riskDecisionId: decision.decisionId },
                decision,
                stateVersion: 2,
                updatedAt: intent.createdAt,
              }
              records.set(intent.intentId, record)
              return { record, deduplicated: false }
            }),
        }),
        Effect.provideService(MutationStore, { latest: () => Effect.void } as unknown as MutationStoreShape),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test.each([undefined, 5_000])(
    'a failed post-pass projection check owns its retry delay (%s)',
    async (failureDelay) => {
      const result = {
        outcome: 'RECOVERED',
        action: 'WAITING',
        waitReason: 'CLOSE_QUOTE_PENDING',
        observedAt: at,
        cycle: activeCycle,
      } as const
      const advanced = {
        result,
        observation: {
          result: 'SUCCESS',
          outcome: 'RECOVERED',
          recoveryAction: 'WAITING',
          waitReason: 'CLOSE_QUOTE_PENDING',
          observedAt: at,
        } as const,
        nextDelayMs: 1_000,
      }
      let checks = 0
      const checked = checkAdvancedMarketProjection(
        advanced,
        Effect.sync(() => {
          checks += 1
        }).pipe(Effect.andThen(Effect.fail(marketFailure))),
        (error) => {
          expect(error.cause).toBe(marketFailure)
          return Effect.succeed({
            observation: {
              result: 'FAILURE',
              observedAt: at,
              operation: error.operation,
              failure: error.failure,
              message: error.message,
            },
            ...(failureDelay === undefined ? {} : { nextDelayMs: failureDelay }),
          })
        },
      )
      const outcome = await Effect.runPromise(
        advanceExecutionOnce(
          {
            controllerKey: 'a'.repeat(64),
            epoch: 1,
            sequence: 0,
            issuedAt: at,
            sourceRevision: 'd'.repeat(40),
          },
          { advance: checked, nextDelayMs: 30_000 },
        ),
      )
      expect(checks).toBe(1)
      expect(outcome).toMatchObject({
        _tag: 'Blocked',
        nextDelayMs: failureDelay ?? 30_000,
        observation: { result: 'FAILURE', failure: 'market-data' },
      })
    },
  )

  test('successful projection validation preserves the completed pass', async () => {
    const advanced = {
      observation: {
        result: 'SUCCESS',
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        waitReason: 'CLOSE_QUOTE_PENDING',
        observedAt: at,
      } as const,
      nextDelayMs: 1_000,
    }
    expect(
      await Effect.runPromise(
        checkAdvancedMarketProjection(advanced, Effect.void, () =>
          Effect.die(new Error('successful health check cannot report a failure')),
        ),
      ),
    ).toBe(advanced)
  })

  test('quote scheduling uses completion time and the remaining session budget', async () => {
    const waiting = {
      outcome: 'RECOVERED',
      action: 'WAITING',
      waitReason: 'CLOSE_QUOTE_PENDING',
      observedAt: at,
      cycle: activeCycle,
    } as const
    const close = Date.parse(activeCycle.window.executionCloseAt)
    expect(closeQuoteContinuationDelayMs(waiting, 30_000, new Date(close - 750).toISOString())).toBe(750)
    expect(closeQuoteContinuationDelayMs(waiting, 30_000, new Date(close + 1).toISOString())).toBeUndefined()
    expect(
      closeQuoteContinuationDelayMs(
        {
          outcome: 'RECOVERED',
          action: 'COMPLETED',
          observedAt: at,
          cycle: activeCycle,
        },
        30_000,
        at,
      ),
    ).toBeUndefined()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(close - 1)
        yield* checkAdvancedMarketProjection(
          {
            result: waiting,
            observation: { result: 'SUCCESS', outcome: 'RECOVERED', observedAt: at },
          },
          TestClock.setTime(close),
          () => Effect.die(new Error('unexpected failure')),
        )
        expect(closeQuoteContinuationDelayMs(waiting, 30_000, yield* currentUtcInstant)).toBeUndefined()
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test('a short durable continuation catches a delayed quote that expires during the ordinary idle interval', async () => {
    const request = await fixture()
    const start = Date.parse(at) + 16 * 60_000 + 24_000
    const quoteEventAt = new Date(start + 3_100).toISOString()
    const quoteAvailableAt = start + 8_800
    const loadSnapshot: IntradayMarketDataService['loadSnapshot'] = (query) =>
      Effect.try({
        try: () => {
          const raw = makeIntradayMomentumTestSnapshot(
            native.protocol,
            { ...query, archiveWatermarks: [] },
            { AAPL: 0.02 },
            10,
          )
          const eventAt =
            Date.parse(query.observedAt) >= quoteAvailableAt ? quoteEventAt : new Date(start - 16_000).toISOString()
          return streamingFixtureFromRaw(
            {
              ...raw,
              quotes: raw.quotes.map((quote) => ({
                ...quote,
                eventAt,
                ingestedAt: new Date(Date.parse(eventAt) + 5_700).toISOString(),
              })),
            },
            query,
          ).snapshot
        },
        catch: (cause) =>
          retryableOperationalError({
            component: 'market-data',
            operation: 'snapshot',
            message: 'Fixture quote cut unavailable',
            cause,
          }),
      })
    const reconcile = Effect.gen(function* () {
      yield* TestClock.adjust(3_000)
      return factsAt(yield* currentUtcInstant, true)
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const close = prepareClosingExecutionCycleDecision({
          ...request,
          input: { ...request.input, intradayMarketData: { ...freshMarket, loadSnapshot } },
          reconcile,
        })
        const first = yield* Effect.flip(close)
        expect(first).toMatchObject({ quotePending: true, readiness: { reason: 'SNAPSHOT_STALE', symbol: 'AAPL' } })
        const result = {
          outcome: 'RECOVERED',
          action: 'WAITING',
          waitReason: 'CLOSE_QUOTE_PENDING',
          observedAt: first instanceof ExecutionCloseAwaitingMarketData ? first.observedAt : '',
          cycle: request.cycle,
        } as const
        const nextDelayMs = closeQuoteContinuationDelayMs(result, 30_000, yield* currentUtcInstant)
        expect(nextDelayMs).toBe(1_000)
        const command = {
          controllerKey: 'a'.repeat(64),
          epoch: 1,
          sequence: 0,
          issuedAt: result.observedAt,
          sourceRevision: 'd'.repeat(40),
        }
        const outcome = yield* advanceExecutionOnce(command, {
          advance: Effect.succeed({
            result,
            observation: {
              result: 'SUCCESS',
              outcome: 'RECOVERED',
              recoveryAction: 'WAITING',
              observedAt: result.observedAt,
              waitReason: 'CLOSE_QUOTE_PENDING',
            },
            ...(nextDelayMs === undefined ? {} : { nextDelayMs }),
          }),
          nextDelayMs: 30_000,
        })
        const activated = Result.getOrThrow(
          decideExecutionControllerActivation(null, {
            schemaVersion: 'bayn.execution-controller-activation.v1',
            controllerKey: command.controllerKey,
            epoch: 1,
            firstSequence: 0,
            planHash: 'b'.repeat(64),
            sourceRevision: command.sourceRevision,
          }),
        ).state
        expect(outcome._tag).toBe('Waiting')
        const completed = Result.getOrThrow(
          completeExecutionControllerTick(
            activated,
            { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
            {
              completedAt: result.observedAt,
              outcome: {
                _tag: ExecutionControllerOutcome.Waiting,
                receiptHash: outcome.receiptHash,
                nextDelayMs: outcome.nextDelayMs,
              },
            },
            command.sourceRevision,
          ),
        )
        const restarted = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(completed))))
        expect(restarted.nextDueAt).toBe(new Date(start + 4_000).toISOString())
        expect(
          Result.getOrThrow(
            decideExecutionControllerTick(
              restarted,
              { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
              command.controllerKey,
              restarted.nextDueAt ?? '',
              command.sourceRevision,
            ),
          )._tag,
        ).toBe('Ignored')
        yield* TestClock.adjust(nextDelayMs ?? 30_000)
        expect(yield* Effect.flip(close)).toMatchObject({ quotePending: true })
        yield* TestClock.adjust(nextDelayMs ?? 30_000)
        const ready = yield* close
        expect(ready.document.dispatchable).toBe(true)
        expect(ready.document.targetPlan.intentTargets.every((target) => target.orderType === OrderType.Limit)).toBe(
          true,
        )
        expect(Date.parse(yield* currentUtcInstant) - Date.parse(quoteEventAt)).toBe(7_900)

        yield* TestClock.setTime(start + 3_000 + 30_000)
        const missed = yield* Effect.flip(close)
        expect(missed).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test('only quote-pending closes before the session deadline use a bounded continuation', () => {
    const waiting = {
      outcome: 'RECOVERED',
      action: 'WAITING',
      waitReason: 'CLOSE_QUOTE_PENDING',
      observedAt: at,
      cycle: activeCycle,
    } as const
    expect(closeQuoteContinuationDelayMs(waiting, 500, at)).toBe(500)
    expect(
      closeQuoteContinuationDelayMs({ ...waiting, waitReason: 'CLOSE_MARKET_DATA_UNAVAILABLE' }, 30_000, at),
    ).toBeUndefined()
    expect(closeQuoteContinuationDelayMs({ ...waiting, waitReason: 'JEV_POSITION_HELD' }, 30_000, at)).toBeUndefined()
    expect(closeQuoteContinuationDelayMs(waiting, 30_000, activeCycle.window.executionCloseAt)).toBeUndefined()
  })

  test('an unavailable intraday cut preserves its cause without a second reconciliation', async () => {
    const request = await fixture()
    let reads = 0
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at) + 60_000)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) },
            },
            reconcile: currentUtcInstant.pipe(
              Effect.map((now) => {
                reads += 1
                return factsAt(now, true)
              }),
            ),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(1)
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure.cause).toBe(marketFailure)
    if (!(failure instanceof ExecutionCloseAwaitingMarketData)) throw new Error('Expected a close wait')
    expect(executionCloseMarketDataDiagnostics(failure)).toMatchObject({
      component: 'market-data',
      operation: 'snapshot',
      snapshotFailure: 'not-ready',
    })
    expect(failure).toMatchObject({
      message: marketFailure.message,
      readiness: { reason: 'SNAPSHOT_UNAVAILABLE', message: unavailable.message, symbol: 'AAPL' },
    })
  })

  test('an absent executable quote never receives the stale-quote continuation', async () => {
    const request = await fixture()
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at) + 60_000)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: {
                ...freshMarket,
                // Fault injection at the capability boundary: even if a reader omits the held-symbol
                // quote, absence is unavailable data, not a present quote awaiting refresh.
                loadSnapshot: (query) =>
                  freshMarket.loadSnapshot(query).pipe(Effect.map((snapshot) => ({ ...snapshot, latestQuotes: {} }))),
              },
            },
            reconcile: currentUtcInstant.pipe(Effect.map((now) => factsAt(now, true))),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure).toMatchObject({
      quotePending: false,
      readiness: { reason: 'SNAPSHOT_UNAVAILABLE', symbol: 'AAPL' },
      cause: { operation: 'close-quote-not-ready', symbol: 'AAPL' },
    })
  })

  test.each([0, -1])('fallback is allowed when the archive finishes at the window boundary (%ims)', async (offset) => {
    const request = await fixture()
    let reads = 0
    const start = Date.parse(request.cycle.window.executionCloseAt) - native.protocol.flattenBeforeCloseMinutes * 60_000
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start + offset)
        return yield* prepareClosingExecutionCycleDecision({
          ...request,
          input: {
            ...request.input,
            intradayMarketData: {
              ...freshMarket,
              loadSnapshot: () => TestClock.setTime(start).pipe(Effect.andThen(Effect.fail(marketFailure))),
            },
          },
          reconcile: currentUtcInstant.pipe(
            Effect.map((now) => {
              reads += 1
              return factsAt(now, true)
            }),
          ),
        })
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(2)
    expect(result.document.bindings.executionMarketData?.schemaVersion).toBe(
      'bayn.reconciled-position-liquidation-binding.v1',
    )
    expect(result.document.targetPlan.intentTargets.every((target) => target.orderType === OrderType.Market)).toBe(true)
  })

  test('the second boundary check still refuses a fallback that expires during reconciliation', async () => {
    const request = await fixture()
    let reads = 0
    const close = Date.parse(request.closeExpiresAt)
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(close - 1)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) },
            },
            reconcile: Effect.gen(function* () {
              reads += 1
              if (reads === 2) yield* TestClock.setTime(close)
              return factsAt(yield* currentUtcInstant, true)
            }),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(2)
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure.message).toBe(marketFailure.message)
  })
})
