import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Ref,
  Result,
} from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetStatus,
  BrokerRead,
  make as makeAlpacaRead,
  type AccountConfigurationObservation,
  type AssetObservation,
  type BrokerReadShape,
  type ReadEvidence,
  type ReadOptions,
  type ReadResult,
} from './broker/alpaca'
import { makeStrategyProtocolHash, type RuntimeProvenance } from './contracts'
import { CycleState, type AutonomousCycle } from './cycle'
import type { CycleOperationsProjection } from './cycle-observability'
import { CycleObservability, type CycleObservabilityShape } from './db/cycle-observability'
import { CycleStore, type CycleStoreShape } from './db/cycle-store'
import { PostgresClientLive } from './db/evidence-store'
import { canonicalHashV1 } from './hash'
import { Authority, KillState, OrderSide, OrderType, ReconciliationStatus, RiskOutcome, TimeInForce } from './paper'
import {
  PaperCandidateIneligibility,
  discoverPaperCandidates,
  renderPaperCandidateDiscoveryError,
  validatePaperCandidateDiscoveryObservations,
  validatePaperCandidateDiscoverySnapshot,
  type PaperCandidateDiscoveryIdentity,
  type PaperCandidateFactsMaterial,
} from './paper-candidate-discovery'
import { validatePaperCandidateDiscoveryObservations as validateObservationsImplementation } from './paper-candidate-discovery/broker-observation-validation'
import { renderPaperCandidateDiscoveryError as renderErrorImplementation } from './paper-candidate-discovery/failure'
import { PaperCandidateIneligibility as PaperCandidateIneligibilityImplementation } from './paper-candidate-discovery/model'
import { discoverPaperCandidates as discoverPaperCandidatesImplementation } from './paper-candidate-discovery/program'
import { validatePaperCandidateDiscoverySnapshot as validateSnapshotImplementation } from './paper-candidate-discovery/snapshot-validation'
import { Gate, Reason } from './risk'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'
import { TargetPlanStatus } from './target-planner'

const hash = (character: string): string => character.repeat(64)
const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const qualificationRunId = hash('1')
const snapshotId = hash('2')
const cycleId = hash('3')
const documentHash = hash('4')
const policyHash = hash('5')
const reconciliationId = hash('6')
const reconciliationHash = hash('7')
const authorityGenerationHash = hash('e')
const cutoff = '2099-07-24T13:15:00.000Z'
const observedAt = '2099-07-24T12:00:00.000Z'
const strategy: RuntimeProvenance['strategy'] = {
  name: 'risk-balanced-trend',
  behaviorHash: hash('8'),
  parameterHash: hash('9'),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v3',
}
const identity: PaperCandidateDiscoveryIdentity = {
  sourceRevision: 'a'.repeat(40),
  image: {
    repository: 'registry.ide-newton.ts.net/lab/bayn',
    digest: `sha256:${hash('b')}`,
  },
  strategy,
  strategyProtocolHash: makeStrategyProtocolHash(strategy),
  qualificationRunId,
  accountId,
  authorityGenerationHash,
  policyHash,
}

const cycle = (): AutonomousCycle =>
  ({
    schemaVersion: 'bayn.autonomous-cycle.v1',
    identity: {
      cycleId,
      strategyName: 'risk-balanced-trend',
      qualificationRunId,
      strategyProtocolHash: identity.strategyProtocolHash,
      accountId,
      signalSessionDate: '2099-07-23',
      executionSessionDate: '2099-07-24',
    },
    window: {
      submissionOpenAt: '2099-07-23T20:05:00.000Z',
      submissionCutoffAt: cutoff,
      executionOpenAt: '2099-07-24T13:30:00.000Z',
      executionCloseAt: '2099-07-24T20:00:00.000Z',
    },
    state: CycleState.Completed,
    bindings: { snapshotId, decisionHash: documentHash },
    stateVersion: 4,
    createdAt: '2099-07-23T20:05:00.000Z',
    updatedAt: '2099-07-23T20:10:00.000Z',
    terminalAt: '2099-07-23T20:10:00.000Z',
  }) as unknown as AutonomousCycle

const projection = (): CycleOperationsProjection => ({
  current: null,
  unfinishedCycleCount: 0,
  last: {
    cycleId,
    accountId,
    signalSessionDate: '2099-07-23',
    executionSessionDate: '2099-07-24',
    phase: CycleState.Completed,
    snapshotId,
    decisionHash: documentHash,
    terminalReason: null,
    submissionOpenAt: '2099-07-23T20:05:00.000Z',
    submissionCutoffAt: cutoff,
    executionOpenAt: '2099-07-24T13:30:00.000Z',
    executionCloseAt: '2099-07-24T20:00:00.000Z',
    createdAt: '2099-07-23T20:05:00.000Z',
    updatedAt: '2099-07-23T20:10:00.000Z',
    terminalAt: '2099-07-23T20:10:00.000Z',
  },
  authority: {
    generationHash: authorityGenerationHash,
    maximum: Authority.Observe,
    effective: Authority.Observe,
    kill: KillState.Clear,
    reason: null,
    updatedAt: '2099-07-23T20:04:00.000Z',
  },
  reconciliation: {
    accountId,
    reconciliationId,
    status: ReconciliationStatus.Exact,
    discrepancyCount: 0,
    reconciledAt: '2099-07-23T20:04:00.000Z',
    coversLatestMutation: true,
  },
  mutations: {
    eventCount: 0,
    unresolvedCount: 0,
    oldestUnresolvedAt: null,
    latestOccurredAt: null,
  },
})

const symbols = ['VNQ', 'SPY'] as const

const risk = (ordinal: number) =>
  ({
    notionalLimitMicros: ordinal === 0 ? '125000000' : '200000000',
    evaluation: {
      policyHash,
      input: {
        inputHash: hash(ordinal === 0 ? 'c' : 'd'),
        intentId: hash(ordinal === 0 ? 'e' : 'f'),
      },
      decision: {
        decisionId: hash(ordinal === 0 ? 'a' : 'b'),
        outcome: RiskOutcome.Blocked,
        reasonCodes: [Reason.AuthorityNotPaper],
      },
      gates: Object.values(Gate).map((name) => ({
        name,
        passed: name !== Gate.Authority,
        reason: name === Gate.Authority ? Reason.AuthorityNotPaper : Reason.KillActive,
      })),
      metrics: {
        orderNotionalMicros: ordinal === 0 ? '100000000' : '150000000',
      },
    },
  }) as unknown as ObserveShadowDecisionDocument['deltaRisk'][number]

const document = (): ObserveShadowDecisionDocument =>
  ({
    schemaVersion: 'bayn.observe-shadow-decision.v1',
    mode: 'OBSERVE',
    dispatchable: false,
    contentHash: documentHash,
    bindings: {
      strategyName: 'risk-balanced-trend',
      cycleId,
      strategyProtocolHash: identity.strategyProtocolHash,
      snapshotId,
      snapshotContentHash: hash('0'),
      snapshotFinalizedAt: '2099-07-23T20:01:00.000Z',
      strategyDecisionHash: hash('a'),
      policyHash,
      accountId,
      planningBrokerStateHash: hash('b'),
      reconciliationId,
      reconciliationHash,
    },
    targetPlan: {
      schemaVersion: 'bayn.paper-reference-target-plan.v1',
      inputHash: hash('c'),
      outputHash: hash('d'),
      status: TargetPlanStatus.Planned,
      reason: null,
      targets: symbols.map((symbol, ordinal) => ({
        symbol,
        targetWeight: ordinal === 0 ? 0.4 : 0.6,
        referencePriceMicros: ordinal === 0 ? '100123500' : '200000000',
        currentQuantityMicros: '1000000',
        targetQuantityMicros: ordinal === 0 ? '2250000' : '2000000',
      })),
      intentTargets: symbols.map((symbol, ordinal) => ({
        strategyName: 'risk-balanced-trend',
        cycleId,
        decisionHash: hash('a'),
        policyHash,
        accountId,
        symbol,
        side: OrderSide.Buy,
        orderType: OrderType.Market,
        timeInForce: TimeInForce.Day,
        quantityMicros: ordinal === 0 ? '1250000' : '1000000',
        createdAt: '2099-07-23T20:05:00.000Z',
      })),
      requiredReferenceBuyNotionalMicros: '250000000',
      availableBuyingPowerMicros: '500000000',
      residualBuyingPowerMicros: '250000000',
    },
    deltaRisk: symbols.map((_, ordinal) => risk(ordinal)),
    createdAt: '2099-07-23T20:05:00.000Z',
    submissionCutoffAt: cutoff,
    expiresAt: cutoff,
  }) as unknown as ObserveShadowDecisionDocument

const evidence = (suffix: string, time: string): ReadEvidence => ({
  requestId: `request-${suffix}`,
  status: 200,
  contentHash: canonicalHashV1({ suffix }),
  observedAt: time,
  rateLimit: { limit: '200', remaining: '199' },
})

const account = (suffix = 'a', time = observedAt): BrokerReadShape['account'] =>
  Effect.succeed({
    value: {
      id: accountId,
      status: AccountStatus.Active,
      currency: 'USD',
      cashMicros: '500000000',
      equityMicros: '1000000000',
      buyingPowerMicros: '500000000',
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      observedAt: time,
    },
    evidence: evidence(suffix, time),
  })

const accountConfiguration = (
  suffix = 'configuration',
  time = observedAt,
  fractionalTrading = true,
): ReadResult<AccountConfigurationObservation> => ({
  value: {
    schemaVersion: 'bayn.alpaca-account-configuration-observation.v1',
    source: 'alpaca-v2-account-configurations',
    requestHash: hash('a'),
    fractionalTrading,
    observedAt: time,
    normalizedResponseHash: hash(fractionalTrading ? 'b' : 'c'),
  },
  evidence: evidence(suffix, time),
})

const asset = (symbol: string, suffix = symbol.toLowerCase(), time = observedAt): ReadResult<AssetObservation> => {
  const eligible = symbol === 'VNQ'
  return {
    value: {
      schemaVersion: 'bayn.alpaca-asset-observation.v1',
      source: 'alpaca-v2-asset',
      requestedSymbol: symbol,
      requestHash: symbol === 'VNQ' ? hash('1') : hash('2'),
      assetId: symbol === 'VNQ' ? 'asset-vnq' : 'asset-spy',
      symbol,
      assetClass: eligible ? AssetClass.UsEquity : AssetClass.UsOption,
      exchange: eligible ? AssetExchange.Arca : AssetExchange.Otc,
      status: eligible ? AssetStatus.Active : AssetStatus.Inactive,
      tradable: eligible,
      fractionable: eligible,
      attributes: eligible ? [] : ['ipo', 'ptp_no_exception'],
      observedAt: time,
      normalizedResponseHash: symbol === 'VNQ' ? hash('3') : hash('4'),
    },
    evidence: evidence(suffix, time),
  }
}

interface TestControl {
  assetSymbols: string[]
  brokerAccountConfigurationReads: number
  brokerAccountReads: number
  cycleReads: number
  decisionReads: number
  inTransaction: boolean
  observabilityReads: number
  statements: string[]
  transactions: number
}

const control = (): TestControl => ({
  assetSymbols: [],
  brokerAccountConfigurationReads: 0,
  brokerAccountReads: 0,
  cycleReads: 0,
  decisionReads: 0,
  inTransaction: false,
  observabilityReads: 0,
  statements: [],
  transactions: 0,
})

const fakeSql = (state: TestControl): PgClient.PgClient => {
  const sql = ((strings: TemplateStringsArray) => {
    state.statements.push(strings.join('?').replace(/\s+/g, ' ').trim())
    return Effect.succeed([])
  }) as unknown as PgClient.PgClient
  return Object.assign(sql, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.sync(() => {
        state.transactions += 1
        state.inTransaction = true
      }).pipe(
        Effect.andThen(effect),
        Effect.ensuring(
          Effect.sync(() => {
            state.inTransaction = false
          }),
        ),
      ),
  }) as PgClient.PgClient
}

interface Fixture {
  readonly projection: CycleOperationsProjection
  readonly cycle: Option.Option<AutonomousCycle>
  readonly document: Option.Option<ObserveShadowDecisionDocument>
}

const fixture = (): Fixture => ({
  projection: projection(),
  cycle: Option.some(cycle()),
  document: Option.some(document()),
})

const stores = (state: TestControl, input: Fixture) => {
  const inReadTransaction = <A>(value: A, operation: 'cycle' | 'document') =>
    Effect.sync(() => {
      if (!state.inTransaction) throw new Error(`${operation} read escaped the transaction`)
      if (operation === 'cycle') state.cycleReads += 1
      else state.decisionReads += 1
      return value
    })
  const unexpected = () => Effect.die(new Error('unexpected CycleStore mutation or unrelated read'))
  const observability: CycleObservabilityShape = {
    read: () =>
      Effect.sync(() => {
        if (!state.inTransaction) throw new Error('observability read escaped the transaction')
        state.observabilityReads += 1
        return input.projection
      }),
  }
  const cycleStore: CycleStoreShape = {
    acquire: unexpected,
    read: () => inReadTransaction(input.cycle, 'cycle'),
    readAuthoritySlot: unexpected,
    readDecisionDocument: () => inReadTransaction(input.document, 'document'),
    readOldestUnfinished: unexpected,
    bindSnapshot: unexpected,
    activate: unexpected,
    bindDecision: unexpected,
    finish: unexpected,
    block: unexpected,
  }
  return { observability, cycleStore }
}

const broker = (state: TestControl, suffix = 'a', time = observedAt, fractionalTrading = true): BrokerReadShape => {
  const unexpected = Effect.die(new Error('unexpected broker read'))
  return {
    account: Effect.sync(() => {
      state.brokerAccountReads += 1
    }).pipe(Effect.andThen(account(suffix, time))),
    accountConfiguration: Effect.sync(() => {
      state.brokerAccountConfigurationReads += 1
      return accountConfiguration(`${suffix}-configuration`, time, fractionalTrading)
    }),
    assetBySymbol: (symbol) =>
      Effect.sync(() => {
        state.assetSymbols.push(symbol)
        return asset(symbol, `${suffix}-${symbol.toLowerCase()}`, time)
      }),
    positions: unexpected,
    orders: () => unexpected,
    orderById: () => unexpected,
    orderByClientId: () => unexpected,
    fillActivities: () => unexpected,
    marketCalendar: () => unexpected,
  }
}

const program = (
  state: TestControl,
  input: Fixture = fixture(),
  read: BrokerReadShape = broker(state),
  now = observedAt,
  sql: PgClient.PgClient = fakeSql(state),
  candidateIdentity: PaperCandidateDiscoveryIdentity = identity,
) => {
  const { observability, cycleStore } = stores(state, input)
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now))
    return yield* discoverPaperCandidates(candidateIdentity)
  }).pipe(
    Effect.provideService(PgClient.PgClient, sql),
    Effect.provideService(CycleObservability, observability),
    Effect.provideService(CycleStore, cycleStore),
    Effect.provideService(BrokerRead, read),
    Effect.provide(TestClock.layer()),
  )
}

describe('paper candidate discovery', () => {
  test('preserves the public facade exports', () => {
    expect(PaperCandidateIneligibility).toBe(PaperCandidateIneligibilityImplementation)
    expect(discoverPaperCandidates).toBe(discoverPaperCandidatesImplementation)
    expect(renderPaperCandidateDiscoveryError).toBe(renderErrorImplementation)
    expect(validatePaperCandidateDiscoveryObservations).toBe(validateObservationsImplementation)
    expect(validatePaperCandidateDiscoverySnapshot).toBe(validateSnapshotImplementation)
  })

  test('returns fact-bearing Result failures from pure snapshot and receipt decisions', () => {
    const missingAuthoritySnapshot = {
      projection: { ...projection(), authority: null },
      cycle: cycle(),
      document: document(),
    }
    const snapshotFailure = validatePaperCandidateDiscoverySnapshot(
      identity,
      missingAuthoritySnapshot,
      Date.parse(observedAt),
    )

    expect(Result.isFailure(snapshotFailure)).toBe(true)
    if (Result.isFailure(snapshotFailure)) {
      expect(snapshotFailure.failure).toMatchObject({
        _tag: 'AuthorityMismatch',
        failure: 'authority-mismatch',
        expectedGenerationHash: authorityGenerationHash,
        observedGenerationHash: null,
      })
      expect(renderPaperCandidateDiscoveryError(snapshotFailure.failure)).toBe(
        `paper candidate authority mismatch: expectedGeneration=${authorityGenerationHash} observedGeneration=none maximum=none effective=none`,
      )
    }

    const validSnapshot = {
      projection: projection(),
      cycle: cycle(),
      document: document(),
    }
    const validatedSnapshot = validatePaperCandidateDiscoverySnapshot(identity, validSnapshot, Date.parse(observedAt))
    expect(Result.isSuccess(validatedSnapshot)).toBe(true)
    if (Result.isFailure(validatedSnapshot)) return

    const observedAccount = Effect.runSync(account())
    const observationFailure = validatePaperCandidateDiscoveryObservations(validatedSnapshot.success, {
      account: {
        ...observedAccount,
        value: { ...observedAccount.value, id: '0f52e894-e17a-4b30-9a8f-e9f1f6fb701e' },
      },
      accountConfiguration: accountConfiguration(),
      assets: symbols.map((symbol) => asset(symbol)),
      capturedAtMs: Date.parse(observedAt),
    })

    expect(Result.isFailure(observationFailure)).toBe(true)
    if (Result.isFailure(observationFailure)) {
      expect(observationFailure.failure).toMatchObject({
        _tag: 'AccountMismatch',
        failure: 'account-mismatch',
        expectedAccountId: accountId,
        observedAccountId: '0f52e894-e17a-4b30-9a8f-e9f1f6fb701e',
      })
    }
  })

  test('reads one immutable snapshot and emits every ordered candidate without mutation capabilities', async () => {
    const state = control()
    const receipt = await Effect.runPromise(program(state))
    const publicCandidateFacts: PaperCandidateFactsMaterial = receipt.candidateFacts

    expect(state.transactions).toBe(1)
    expect(publicCandidateFacts).toBe(receipt.candidateFacts)
    expect(state.statements).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'])
    expect(state.cycleReads).toBe(1)
    expect(state.decisionReads).toBe(1)
    expect(state.brokerAccountReads).toBe(1)
    expect(state.brokerAccountConfigurationReads).toBe(1)
    expect(state.assetSymbols).toEqual([...symbols])
    expect(receipt).toMatchObject({
      schemaVersion: 'bayn.paper-candidate-discovery.v2',
      operation: 'PAPER_CANDIDATE_DISCOVERY',
      authority: Authority.Observe,
      dispatchable: false,
      binding: {
        runtime: { authorityGenerationHash },
        cycle: { cycleId, decisionHash: documentHash },
        document: { reconciliationId, policyHash },
      },
      candidateFacts: {
        schemaVersion: 'bayn.paper-candidate-facts.v1',
        accountConfiguration: {
          fractionalTrading: true,
        },
        consistencyDelayMs: { status: 'REQUIRED_UNBOUND' },
        candidates: [
          {
            ordinal: 0,
            observedPlanIntentId: hash('e'),
            symbol: 'VNQ',
            observedPlannedQuantityMicros: '1250000',
            observedReferencePriceMicros: '100123500',
            assetEligibility: { eligible: true, reasons: [] },
            fractionalTradingEligible: true,
          },
          {
            ordinal: 1,
            symbol: 'SPY',
            observedPlannedQuantityMicros: '1000000',
            assetEligibility: {
              eligible: false,
              reasons: [
                PaperCandidateIneligibility.AssetClass,
                PaperCandidateIneligibility.Inactive,
                PaperCandidateIneligibility.NotTradable,
                PaperCandidateIneligibility.NotFractionable,
                PaperCandidateIneligibility.Otc,
                PaperCandidateIneligibility.Ipo,
                PaperCandidateIneligibility.PtpNoException,
              ],
            },
            fractionalTradingEligible: false,
          },
        ],
      },
      observationReceiptSchemaVersion: 'bayn.paper-candidate-observation-receipt.v1',
      observations: {
        accountConfiguration: {
          value: { fractionalTrading: true },
        },
      },
    })
    const serialized = JSON.stringify(receipt)
    expect(receipt.immutableBindingHash).toBe('6ab1d19be479bfbd58e7ae673864b57913dcf8d0817d6087655468eda84ac9a5')
    expect(receipt.candidateFactsHash).toBe('e3c32cfc6678d5d465ae216567b91bbacdf545c66073442f39e3d056c351e40b')
    expect(receipt.observationReceiptHash).toBe('6ea8f7e85e513490e4567509dad11d071deba2a9792d3b72219c07c250208d46')
    expect(createHash('sha256').update(serialized).digest('hex')).toBe(
      '6f64a60a8181c61acd2ae0577907e59c95d99ea8fbc1f53f5b33d419e74cb049',
    )
    expect(serialized).not.toContain('account_number')
    expect(serialized).not.toContain('paper-secret')
  })

  test('rejects an invalid identity before any database or broker I/O', async () => {
    const state = control()
    const error = await Effect.runPromise(
      Effect.flip(
        program(state, fixture(), broker(state), observedAt, fakeSql(state), {
          ...identity,
          strategyProtocolHash: hash('f'),
        }),
      ),
    )

    expect(error).toMatchObject({ _tag: 'StrategyProtocolMismatch', failure: 'invalid-input' })
    expect(state).toMatchObject({
      transactions: 0,
      statements: [],
      observabilityReads: 0,
      cycleReads: 0,
      decisionReads: 0,
      brokerAccountReads: 0,
      brokerAccountConfigurationReads: 0,
      assetSymbols: [],
    })
  })

  test('propagates interruption through an in-flight broker read and runs its finalizer once', async () => {
    const state = control()
    const finalizations = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const finalized = yield* Ref.make(0)
          const base = broker(state)
          const interruptedRead: BrokerReadShape = {
            ...base,
            account: Effect.sync(() => {
              state.brokerAccountReads += 1
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Ref.update(finalized, (count) => count + 1)),
            ),
          }
          const fiber = yield* program(state, fixture(), interruptedRead).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          return yield* Ref.get(finalized)
        }),
      ),
    )

    expect(finalizations).toBe(1)
    expect(state.transactions).toBe(1)
    expect(state.inTransaction).toBe(false)
    expect(state.brokerAccountReads).toBe(1)
    expect(state.brokerAccountConfigurationReads).toBe(0)
    expect(state.assetSymbols).toEqual([])
  })

  test('constructs the read adapter without preflight and receipts only bounded DISCOVER GETs', async () => {
    const state = control()
    const requests: Array<{ method: string; path: string }> = []
    const readOptions: ReadOptions = {
      expectedAccountId: accountId,
      key: Redacted.make('paper-key'),
      secret: Redacted.make('paper-secret'),
      proxyUrl: 'http://bayn-egress-proxy:3128',
      operationTimeoutMs: 1_000,
      retryAttempts: 0,
    }
    const client = HttpClient.make((request, url) => {
      requests.push({ method: request.method, path: url.pathname })
      let body: unknown
      if (url.pathname === '/v2/account') {
        body = {
          id: accountId,
          account_number: 'REDACTED',
          status: 'ACTIVE',
          currency: 'USD',
          cash: '500',
          equity: '1000',
          buying_power: '500',
          account_blocked: false,
          trading_blocked: false,
          trade_suspended_by_user: false,
        }
      } else if (url.pathname === '/v2/account/configurations') {
        body = { fractional_trading: true }
      } else {
        const symbol = decodeURIComponent(url.pathname.slice('/v2/assets/'.length))
        body = {
          id: symbol === 'VNQ' ? '6ecbbd80-1456-4ae5-a623-97c007054f86' : 'f21fcb6b-92f2-46ba-9979-d5f4c73570d1',
          class: 'us_equity',
          exchange: 'ARCA',
          symbol,
          status: 'active',
          tradable: true,
          fractionable: true,
          attributes: [],
        }
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-request-id': `request-${requests.length}` },
          }),
        ),
      )
    })

    const receipt = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const brokerContext = yield* Layer.build(
            Layer.effect(BrokerRead, makeAlpacaRead(readOptions)).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
            ),
          )
          expect(requests).toEqual([])
          return yield* program(state, fixture(), Context.get(brokerContext, BrokerRead))
        }),
      ),
    )

    expect(receipt.candidateFacts.candidates).toHaveLength(symbols.length)
    expect(requests.slice(0, 2)).toEqual([
      { method: 'GET', path: '/v2/account' },
      { method: 'GET', path: '/v2/account/configurations' },
    ])
    expect(requests.slice(2).sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { method: 'GET', path: '/v2/assets/SPY' },
      { method: 'GET', path: '/v2/assets/VNQ' },
    ])
  })

  test('keeps immutable and semantic hashes stable while fresh GET evidence changes the receipt', async () => {
    const firstState = control()
    const secondState = control()
    const first = await Effect.runPromise(program(firstState))
    const second = await Effect.runPromise(
      program(secondState, fixture(), broker(secondState, 'z', '2099-07-24T12:01:00.000Z'), '2099-07-24T12:01:00.000Z'),
    )

    expect(second.immutableBindingHash).toBe(first.immutableBindingHash)
    expect(second.candidateFactsHash).toBe(first.candidateFactsHash)
    expect(second.observationReceiptHash).not.toBe(first.observationReceiptHash)
    expect(second.observations.account.evidence.requestId).not.toBe(first.observations.account.evidence.requestId)
  })

  test('normalizes adapter-shaped optional rate-limit evidence before hashing the receipt', async () => {
    const state = control()
    const read = broker(state)
    const normalizedState = control()
    const normalizedRead = broker(normalizedState)
    const adapterShaped: BrokerReadShape = {
      ...read,
      account: read.account.pipe(
        Effect.map((result) => ({
          ...result,
          evidence: { ...result.evidence, rateLimit: undefined },
        })),
      ),
      accountConfiguration: read.accountConfiguration.pipe(
        Effect.map((result) => ({
          ...result,
          evidence: {
            ...result.evidence,
            rateLimit: {
              limit: '200',
              remaining: '199',
              reset: undefined,
              retryAfter: undefined,
            },
          },
        })),
      ),
      assetBySymbol: (symbol) =>
        read.assetBySymbol(symbol).pipe(
          Effect.map((result) => ({
            ...result,
            evidence: {
              ...result.evidence,
              rateLimit: {
                limit: '200',
                remaining: '199',
                reset: undefined,
                retryAfter: undefined,
              },
            },
          })),
        ),
    }
    const alreadyNormalized: BrokerReadShape = {
      ...normalizedRead,
      account: normalizedRead.account.pipe(
        Effect.map((result) => ({
          ...result,
          evidence: {
            requestId: result.evidence.requestId,
            status: result.evidence.status,
            contentHash: result.evidence.contentHash,
            observedAt: result.evidence.observedAt,
          },
        })),
      ),
      accountConfiguration: normalizedRead.accountConfiguration.pipe(
        Effect.map((result) => ({
          ...result,
          evidence: {
            requestId: result.evidence.requestId,
            status: result.evidence.status,
            contentHash: result.evidence.contentHash,
            observedAt: result.evidence.observedAt,
            rateLimit: { limit: '200', remaining: '199' },
          },
        })),
      ),
    }

    const receipt = await Effect.runPromise(program(state, fixture(), adapterShaped))
    const normalizedReceipt = await Effect.runPromise(program(normalizedState, fixture(), alreadyNormalized))

    expect(receipt.observations.account.evidence).not.toHaveProperty('rateLimit')
    expect(receipt.observations.accountConfiguration.evidence.rateLimit).toEqual({
      limit: '200',
      remaining: '199',
    })
    expect(receipt.observations.accountConfiguration.evidence.rateLimit).not.toHaveProperty('reset')
    expect(receipt.observations.accountConfiguration.evidence.rateLimit).not.toHaveProperty('retryAfter')
    expect(receipt.observations.assets[0]?.evidence.rateLimit).toEqual({ limit: '200', remaining: '199' })
    expect(receipt.observations.assets[0]?.evidence.rateLimit).not.toHaveProperty('reset')
    expect(receipt.observations.assets[0]?.evidence.rateLimit).not.toHaveProperty('retryAfter')
    expect(receipt.observationReceiptHash).toBe(normalizedReceipt.observationReceiptHash)
  })

  test('does not start asset reads when the account observation mismatches the configured account', async () => {
    const state = control()
    const read = broker(state)
    const wrongAccount: BrokerReadShape = {
      ...read,
      account: read.account.pipe(
        Effect.map((result) => ({
          ...result,
          value: { ...result.value, id: '0f52e894-e17a-4b30-9a8f-e9f1f6fb701e' },
        })),
      ),
    }

    const error = await Effect.runPromise(Effect.flip(program(state, fixture(), wrongAccount)))

    expect(error).toMatchObject({
      _tag: 'AccountMismatch',
      failure: 'account-mismatch',
    })
    expect(state.brokerAccountReads).toBe(1)
    expect(state.brokerAccountConfigurationReads).toBe(0)
    expect(state.assetSymbols).toEqual([])
  })

  test('retains candidates but never marks them fractional-trading eligible when the account setting is disabled', async () => {
    const state = control()
    const receipt = await Effect.runPromise(program(state, fixture(), broker(state, 'a', observedAt, false)))

    expect(receipt.candidateFacts.accountConfiguration.fractionalTrading).toBe(false)
    expect(receipt.candidateFacts.candidates).toHaveLength(symbols.length)
    expect(receipt.candidateFacts.candidates[0]).toMatchObject({
      symbol: 'VNQ',
      assetEligibility: { eligible: true, reasons: [] },
      fractionalTradingEligible: false,
    })
    expect(receipt.candidateFacts.candidates.every((candidate) => !candidate.fractionalTradingEligible)).toBe(true)
  })

  test('fails typed before asset reads when account configuration evidence is not causal', async () => {
    const state = control()
    const read = broker(state)
    const nonCausal: BrokerReadShape = {
      ...read,
      accountConfiguration: Effect.succeed(
        accountConfiguration('configuration-before-account', '2099-07-24T11:59:59.999Z'),
      ),
    }

    const error = await Effect.runPromise(Effect.flip(program(state, fixture(), nonCausal)))

    expect(error).toMatchObject({
      _tag: 'ObservationChronologyMismatch',
      failure: 'broker',
    })
    expect(state.brokerAccountReads).toBe(1)
    expect(state.assetSymbols).toEqual([])
  })

  test('fails typed before broker reads for unfinished, missing, stale, and mismatched evidence', async () => {
    const cases: readonly [string, (base: Fixture) => Fixture, string, string][] = [
      [
        'unfinished cycle',
        (base) => ({
          ...base,
          projection: { ...base.projection, unfinishedCycleCount: 1, current: base.projection.last },
        }),
        'cycle-unfinished',
        observedAt,
      ],
      ['missing cycle', (base) => ({ ...base, cycle: Option.none() }), 'cycle-missing', observedAt],
      ['missing document', (base) => ({ ...base, document: Option.none() }), 'document-missing', observedAt],
      ['stale document', (base) => base, 'document-stale', '2099-07-24T13:15:00.000Z'],
      [
        'missing durable authority generation',
        (base) => ({ ...base, projection: { ...base.projection, authority: null } }),
        'authority-mismatch',
        observedAt,
      ],
      [
        'mismatched durable authority generation',
        (base) => ({
          ...base,
          projection: {
            ...base.projection,
            authority: {
              ...base.projection.authority!,
              generationHash: hash('f'),
            },
          },
        }),
        'authority-mismatch',
        observedAt,
      ],
      [
        'PAPER durable authority',
        (base) => ({
          ...base,
          projection: {
            ...base.projection,
            authority: {
              generationHash: authorityGenerationHash,
              maximum: Authority.Paper,
              effective: Authority.Paper,
              kill: KillState.Clear,
              reason: null,
              updatedAt: '2099-07-23T20:04:00.000Z',
            },
          },
        }),
        'authority-mismatch',
        observedAt,
      ],
      [
        'mismatched policy',
        (base) => ({
          ...base,
          document: Option.map(base.document, (value) => ({
            ...value,
            bindings: { ...value.bindings, policyHash: hash('f') },
          })),
        }),
        'document-mismatch',
        observedAt,
      ],
      [
        'mismatched operational snapshot',
        (base) => ({
          ...base,
          projection: {
            ...base.projection,
            last: base.projection.last === null ? null : { ...base.projection.last, snapshotId: hash('f') },
          },
        }),
        'document-mismatch',
        observedAt,
      ],
      [
        'additional risk block',
        (base) => ({
          ...base,
          document: Option.map(base.document, (value) => ({
            ...value,
            deltaRisk: value.deltaRisk.map((entry, index) =>
              index === 0
                ? {
                    ...entry,
                    evaluation: {
                      ...entry.evaluation,
                      decision: {
                        ...entry.evaluation.decision,
                        reasonCodes: [Reason.AuthorityNotPaper, Reason.KillActive],
                      },
                    },
                  }
                : entry,
            ),
          })),
        }),
        'risk-mismatch',
        observedAt,
      ],
    ]

    for (const [label, mutate, expectedFailure, now] of cases) {
      const state = control()
      const error = await Effect.runPromise(Effect.flip(program(state, mutate(fixture()), broker(state), now)))
      expect(error, label).toMatchObject({
        failure: expectedFailure,
      })
      expect(state.brokerAccountReads, label).toBe(0)
      expect(state.brokerAccountConfigurationReads, label).toBe(0)
      expect(state.assetSymbols, label).toEqual([])
    }
  })

  test('reports invalid protocol identity and a cutoff crossed during broker I/O as typed failures', async () => {
    const invalidState = control()
    const invalidIdentity = { ...identity, strategyProtocolHash: hash('f') }
    const invalidExit = await Effect.runPromiseExit(
      program(invalidState, fixture(), broker(invalidState), observedAt, fakeSql(invalidState), invalidIdentity),
    )
    expect(Exit.isFailure(invalidExit)).toBe(true)
    if (Exit.isSuccess(invalidExit)) throw new Error('expected invalid protocol failure')
    const invalidFailure = Cause.findErrorOption(invalidExit.cause)
    expect(Option.isSome(invalidFailure)).toBe(true)
    if (Option.isNone(invalidFailure)) throw new Error('invalid protocol became a defect')
    expect(invalidFailure.value).toMatchObject({
      _tag: 'StrategyProtocolMismatch',
      failure: 'invalid-input',
    })
    expect(invalidState.transactions).toBe(0)
    expect(invalidState.brokerAccountReads).toBe(0)

    const delayedState = control()
    const delayed = broker(delayedState)
    const cutoffDuringRead: BrokerReadShape = {
      ...delayed,
      account: delayed.account.pipe(Effect.tap(() => TestClock.setTime(Date.parse(cutoff)))),
    }
    const cutoffExit = await Effect.runPromiseExit(program(delayedState, fixture(), cutoffDuringRead))
    expect(Exit.isFailure(cutoffExit)).toBe(true)
    if (Exit.isSuccess(cutoffExit)) throw new Error('expected cutoff failure')
    const cutoffFailure = Cause.findErrorOption(cutoffExit.cause)
    expect(Option.isSome(cutoffFailure)).toBe(true)
    if (Option.isNone(cutoffFailure)) throw new Error('post-read cutoff became a defect')
    expect(cutoffFailure.value).toMatchObject({
      _tag: 'DocumentStale',
      failure: 'document-stale',
    })
  })
})

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const describePostgres = postgresUrl === undefined ? describe.skip : describe

describePostgres('paper candidate discovery PostgreSQL transaction', () => {
  test('runs every domain read in one repeatable-read read-only transaction', async () => {
    const runtime = ManagedRuntime.make(
      PostgresClientLive({
        operationTimeoutMs: 5_000,
        postgres: {
          url: Redacted.make(postgresUrl ?? ''),
          tls: false,
          caPath: '/unused',
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    )
    const modes: { isolation: string; readOnly: boolean }[] = []
    const state = control()

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const observeMode = sql<{ isolation: string; read_only: boolean }>`
            SELECT
              current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') = 'on' AS read_only
          `.pipe(
            Effect.orDie,
            Effect.tap((rows) =>
              Effect.sync(() => {
                const mode = rows[0]
                if (mode !== undefined) modes.push({ isolation: mode.isolation, readOnly: mode.read_only })
              }),
            ),
            Effect.asVoid,
          )
          const input = fixture()
          const observability: CycleObservabilityShape = {
            read: () => observeMode.pipe(Effect.as(input.projection)),
          }
          const unexpected = () => Effect.die(new Error('unexpected CycleStore operation'))
          const cycleStore: CycleStoreShape = {
            acquire: unexpected,
            read: () => observeMode.pipe(Effect.as(input.cycle)),
            readAuthoritySlot: unexpected,
            readDecisionDocument: () => observeMode.pipe(Effect.as(input.document)),
            readOldestUnfinished: unexpected,
            bindSnapshot: unexpected,
            activate: unexpected,
            bindDecision: unexpected,
            finish: unexpected,
            block: unexpected,
          }
          yield* TestClock.setTime(Date.parse(observedAt))
          return yield* discoverPaperCandidates(identity).pipe(
            Effect.provideService(CycleObservability, observability),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(BrokerRead, broker(state)),
          )
        }).pipe(Effect.provide(TestClock.layer())),
      )
    } finally {
      await runtime.dispose()
    }

    expect(modes).toEqual([
      { isolation: 'repeatable read', readOnly: true },
      { isolation: 'repeatable read', readOnly: true },
      { isolation: 'repeatable read', readOnly: true },
    ])
  })
})
