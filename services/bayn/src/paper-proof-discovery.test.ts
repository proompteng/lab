import { describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetStatus,
  BrokerRead,
  type AccountConfigurationObservation,
  type AssetObservation,
  type BrokerReadShape,
  type ReadEvidence,
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
  PaperProofCandidateIneligibility,
  discoverPaperProofCandidates,
  type PaperProofDiscoveryIdentity,
} from './paper-proof-discovery'
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
const identity: PaperProofDiscoveryIdentity = {
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
  candidateIdentity: PaperProofDiscoveryIdentity = identity,
) => {
  const { observability, cycleStore } = stores(state, input)
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now))
    return yield* discoverPaperProofCandidates(candidateIdentity)
  }).pipe(
    Effect.provideService(PgClient.PgClient, sql),
    Effect.provideService(CycleObservability, observability),
    Effect.provideService(CycleStore, cycleStore),
    Effect.provideService(BrokerRead, read),
    Effect.provide(TestClock.layer()),
  )
}

describe('paper proof DISCOVER', () => {
  test('reads one immutable snapshot and emits every ordered candidate without mutation capabilities', async () => {
    const state = control()
    const receipt = await Effect.runPromise(program(state))

    expect(state.transactions).toBe(1)
    expect(state.statements).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'])
    expect(state.cycleReads).toBe(1)
    expect(state.decisionReads).toBe(1)
    expect(state.brokerAccountReads).toBe(1)
    expect(state.brokerAccountConfigurationReads).toBe(1)
    expect(state.assetSymbols).toEqual([...symbols])
    expect(receipt).toMatchObject({
      schemaVersion: 'bayn.paper-proof-discovery.v2',
      command: 'PREPARE',
      phase: 'DISCOVER',
      authority: Authority.Observe,
      dispatchable: false,
      binding: {
        runtime: { authorityGenerationHash },
        cycle: { cycleId, decisionHash: documentHash },
        document: { reconciliationId, policyHash },
      },
      candidateFacts: {
        schemaVersion: 'bayn.paper-proof-candidate-facts.v2',
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
                PaperProofCandidateIneligibility.AssetClass,
                PaperProofCandidateIneligibility.Inactive,
                PaperProofCandidateIneligibility.NotTradable,
                PaperProofCandidateIneligibility.NotFractionable,
                PaperProofCandidateIneligibility.Otc,
                PaperProofCandidateIneligibility.Ipo,
                PaperProofCandidateIneligibility.PtpNoException,
              ],
            },
            fractionalTradingEligible: false,
          },
        ],
      },
      observationReceiptSchemaVersion: 'bayn.paper-proof-observation-receipt.v2',
      observations: {
        accountConfiguration: {
          value: { fractionalTrading: true },
        },
      },
    })
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain('account_number')
    expect(serialized).not.toContain('paper-secret')
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
      _tag: 'PaperProofDiscoveryError',
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
      _tag: 'PaperProofDiscoveryError',
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
        _tag: 'PaperProofDiscoveryError',
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
      _tag: 'PaperProofDiscoveryError',
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
      _tag: 'PaperProofDiscoveryError',
      failure: 'document-stale',
    })
  })
})

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const describePostgres = postgresUrl === undefined ? describe.skip : describe

describePostgres('paper proof DISCOVER PostgreSQL transaction', () => {
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
          return yield* discoverPaperProofCandidates(identity).pipe(
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
