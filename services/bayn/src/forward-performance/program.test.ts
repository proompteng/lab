import { describe, expect, test } from 'bun:test'

import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Result } from 'effect'

import { prepareAccounting } from '../accounting/domain'
import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import type { LoadedRuntimeConfig } from '../config'
import { planAccountingReceipt } from '../db/execution-store/decisions'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { DiscrepancyKind, OrderSide, type Fill } from '../execution/contracts'
import { readForwardPerformancePostgres } from './postgres'
import { runForwardPerformance, type ForwardPerformanceReaders } from './program'
import type { ForwardPerformanceCashYieldEvidence } from './model'

const identityResult = makeBrokerIdentity({
  schemaVersion: 'bayn.broker-identity.v2',
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment.Sandbox,
  accountId: 'paper-account-forward-performance',
})
if (Result.isFailure(identityResult)) throw new Error('broker identity fixture failed')

const config: LoadedRuntimeConfig = {
  runtimeMode: 'AutonomousService',
  host: '127.0.0.1',
  port: 8080,
  execution: {
    brokerIdentity: identityResult.success,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  alpaca: {
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    identity: identityResult.success,
    baseUrl: 'https://paper-api.alpaca.markets',
    expectedAccountId: identityResult.success.accountId,
    key: Redacted.make('unused-key'),
    secret: Redacted.make('unused-secret'),
    proxyUrl: 'http://proxy.invalid:3128',
    operationTimeoutMs: 5_000,
    retryAttempts: 2,
    authorityGenerationHash: 'e'.repeat(64),
    reconciliationIntervalMs: 30_000,
  },
  build: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    strategyBehaviorHash: 'c'.repeat(64),
    strategyParameterHash: 'd'.repeat(64),
    verification: 'embedded',
  },
  healthIntervalMs: 30_000,
  operationTimeoutMs: 5_000,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  cyclePollIntervalMs: 30_000,
  clickhouse: {
    url: 'http://clickhouse.invalid',
    username: 'bayn',
    password: Redacted.make('unused'),
    snapshotId: '1'.repeat(64),
    publicationAsOf: '2026-07-20',
    calendarVersion: 'fixture-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2018-01-02',
      dataEnd: '2026-07-20',
      lookbackStart: '2018-01-02',
      evaluationStart: '2019-01-02',
      evaluationEnd: '2026-07-20',
    },
  },
  postgres: { url: Redacted.make('postgresql://unused'), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['3000'], ledger: 7_001 },
}

interface SqlObservation {
  readonly statements: string[]
}

interface SqlFixture {
  readonly extraReconciliationDiscrepancy?: boolean
  readonly preWindowCashResidualMicros?: string
}

const makeReadOnlySql = (observation: SqlObservation, fixture: SqlFixture = {}): PgClient.PgClient => {
  const query = ((strings: TemplateStringsArray) => {
    const statement = strings.join('?').replaceAll(/\s+/g, ' ').trim()
    observation.statements.push(statement)
    if (statement.includes('SELECT reconciliation_id, content_hash, status, discrepancies, reconciled_at')) {
      return Effect.succeed([
        {
          reconciliation_id: hash('a'),
          content_hash: hash('b'),
          status: 'DISCREPANCY',
          discrepancies: [
            {
              discrepancyId: hash('e'),
              kind: DiscrepancyKind.Cash,
              identity: identityResult.success.accountId,
              expected: '1000',
              observed: '1200',
              evidenceHash: hash('f'),
              firstObservedAt: '2026-07-20T21:01:00.000Z',
              lastObservedAt: '2026-07-20T21:01:00.000Z',
            },
            ...(fixture.extraReconciliationDiscrepancy
              ? [
                  {
                    discrepancyId: hash('2'),
                    kind: DiscrepancyKind.Account,
                    identity: identityResult.success.accountId,
                    expected: 'ACTIVE',
                    observed: 'RESTRICTED',
                    evidenceHash: hash('3'),
                    firstObservedAt: '2026-07-20T21:01:00.000Z',
                    lastObservedAt: '2026-07-20T21:01:00.000Z',
                  },
                ]
              : []),
          ],
          reconciled_at: new Date('2026-07-20T21:01:00.000Z'),
        },
      ])
    }
    if (statement.includes('AS cash_yield_micros')) {
      return Effect.succeed([
        {
          reconciliation_id: hash('a'),
          reconciliation_content_hash: hash('b'),
          reconciled_at: new Date('2026-07-20T21:01:00.000Z'),
          baseline_account_event_id: hash('1'),
          baseline_observed_at: new Date('2026-07-19T13:00:00.000Z'),
          baseline_cash_micros: '1000',
          opening_account_event_id: hash('c'),
          opening_observed_at: new Date('2026-07-20T13:00:00.000Z'),
          opening_cash_micros: '1000',
          pre_window_accounted_cash_delta_micros: '0',
          pre_window_cash_residual_micros: fixture.preWindowCashResidualMicros ?? '0',
          closing_account_event_id: hash('d'),
          closing_observed_at: new Date('2026-07-20T21:00:00.000Z'),
          closing_cash_micros: '1200',
          accounted_cash_delta_micros: '0',
          cash_yield_micros: '200',
        },
      ])
    }
    return Effect.succeed(statement.includes('count(*)::integer AS count') ? [{ count: 0 }] : [])
  }) as unknown as PgClient.PgClient
  Object.assign(query, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  })
  return query
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error('forward-performance program fixture failed')
  return result.success
}

const hash = (character: string): string => character.repeat(64)
const verifiedCashYield = {
  source: 'TIGERBEETLE_CASH_YIELD_TRANSFER' as const,
  transferId: '123456789',
  transferTimestampNs: '1784563200000000000',
  amountMicros: '200',
}

describe('forward performance read program', () => {
  test('executes only read-only PostgreSQL statements and never treats zero activity as profitable', async () => {
    const observation: SqlObservation = { statements: [] }
    const sql = makeReadOnlySql(observation)
    let observedCashYieldEvidence: ForwardPerformanceCashYieldEvidence | undefined
    const readers: ForwardPerformanceReaders = {
      postgres: readForwardPerformancePostgres,
      ledger: (_config, _accountId, _plans, cashYieldEvidence) => {
        observedCashYieldEvidence = cashYieldEvidence
        return Effect.succeed({
          totals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
          ledgerExact: true,
          missingLedgerAccountCount: 0,
          openPositionCount: 0,
          cashYieldEvidenceRequired: true,
        })
      },
    }

    const receipt = await Effect.runPromise(
      Effect.scoped(runForwardPerformance(config, readers).pipe(Effect.provide(Layer.succeed(PgClient.PgClient, sql)))),
    )

    expect(observation.statements.length).toBeGreaterThan(8)
    expect(observation.statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    expect(
      observation.statements.filter((statement) =>
        /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|LOCK)\b/i.test(statement),
      ),
    ).toEqual([])
    expect(receipt.evidence.status).toBe('INSUFFICIENT_EVIDENCE')
    expect(receipt.evidence.reasonCodes).toContain('ZERO_COMPLETED_EXECUTIONS')
    expect(receipt.evidence.reasonCodes).toContain('NON_EXACT_RECONCILIATION')
    expect(receipt.evidence.reasonCodes).toContain('CASH_YIELD_EVIDENCE_GAP')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.window).toMatchObject({
      reconciliationStatus: 'DISCREPANCY',
      cashYieldAdjustedExact: false,
    })
    expect(observedCashYieldEvidence).toEqual({
      schemaVersion: 'bayn.forward-performance-cash-yield-evidence.v1',
      reconciliationId: hash('a'),
      reconciliationContentHash: hash('b'),
      reconciledAt: '2026-07-20T21:01:00.000Z',
      baselineAccountEventId: hash('1'),
      baselineObservedAt: '2026-07-19T13:00:00.000Z',
      baselineCashMicros: '1000',
      openingAccountEventId: hash('c'),
      openingObservedAt: '2026-07-20T13:00:00.000Z',
      openingCashMicros: '1000',
      preWindowAccountedCashDeltaMicros: '0',
      preWindowCashResidualMicros: '0',
      closingAccountEventId: hash('d'),
      closingObservedAt: '2026-07-20T21:00:00.000Z',
      closingCashMicros: '1200',
      accountedCashDeltaMicros: '0',
      cashYieldMicros: '200',
    })
  })

  test('does not excuse any reconciliation discrepancy beyond the exact cash-yield residual', async () => {
    const observation: SqlObservation = { statements: [] }
    const sql = makeReadOnlySql(observation, { extraReconciliationDiscrepancy: true })
    const readers: ForwardPerformanceReaders = {
      postgres: readForwardPerformancePostgres,
      ledger: () =>
        Effect.succeed({
          totals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '200',
          },
          ledgerExact: true,
          missingLedgerAccountCount: 0,
          openPositionCount: 0,
          cashYieldEvidenceRequired: true,
          cashYieldEvidence: verifiedCashYield,
        }),
    }

    const receipt = await Effect.runPromise(
      Effect.scoped(runForwardPerformance(config, readers).pipe(Effect.provide(Layer.succeed(PgClient.PgClient, sql)))),
    )

    expect(receipt.evidence.reasonCodes).toContain('NON_EXACT_RECONCILIATION')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.window).toMatchObject({
      reconciliationStatus: 'DISCREPANCY',
      cashYieldAdjustedExact: false,
    })
  })

  test('combines reconciled cash yield with trade PnL in the production receipt', async () => {
    const observation: SqlObservation = { statements: [] }
    const sql = makeReadOnlySql(observation)
    const cycleId = hash('1')
    const qualificationRunId = hash('2')
    const strategyProtocolHash = hash('3')
    const executionPolicyHash = hash('4')
    const strategyExecutionModelHash = hash('5')
    const fill: Fill = {
      schemaVersion: 'bayn.paper-fill.v1',
      accountId: identityResult.success.accountId,
      fillId: 'cash-yield-crossover-fill',
      brokerOrderId: 'cash-yield-crossover-order',
      clientOrderId: 'cash-yield-crossover-client-order',
      symbol: 'NVDA',
      side: OrderSide.Sell,
      quantityMicros: '1000000',
      priceMicros: '900',
      feeMicros: '0',
      occurredAt: '2026-07-20T20:00:00.000Z',
    }
    const prepared = success(
      prepareAccounting(hash('6'), fill, { quantityMicros: '1000000', costMicros: '1000' }, config.tigerBeetle.ledger),
    )
    const receiptPlan = success(
      planAccountingReceipt(prepared, config.tigerBeetle.clusterId.toString(), config.tigerBeetle.ledger),
    )
    const accountingReceipt = { ...receiptPlan, recordedAt: '2026-07-20T20:00:01.000Z' }
    const readers: ForwardPerformanceReaders = {
      postgres: () =>
        Effect.succeed({
          cycles: [
            {
              cycleId,
              qualificationRunId,
              strategyName: 'risk-balanced-trend',
              strategyProtocolHash,
              accountId: identityResult.success.accountId,
              executionPolicyHash,
              strategyExecutionModelHash,
              state: 'COMPLETED',
              submissionOpenAt: '2026-07-20T13:00:00.000Z',
              terminalAt: '2026-07-20T21:00:00.000Z',
            },
          ],
          strategy: {
            qualificationRunId,
            strategyName: 'risk-balanced-trend',
            strategyProtocolHash,
            strategyBehaviorHash: config.build.strategyBehaviorHash,
            strategyParameterHash: config.build.strategyParameterHash,
            strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
            sourceRevision: config.build.sourceRevision,
            imageRepository: config.build.imageRepository,
            imageDigest: config.build.imageDigest,
          },
          reconciliation: {
            reconciliationId: hash('7'),
            contentHash: hash('8'),
            status: 'DISCREPANCY',
            performanceExact: true,
            cashYieldAdjustedExact: true,
            reconciledAt: '2026-07-20T21:01:00.000Z',
          },
          startingCapitalMicros: '1000',
          cashYieldEvidence: {
            schemaVersion: 'bayn.forward-performance-cash-yield-evidence.v1',
            reconciliationId: hash('7'),
            reconciliationContentHash: hash('8'),
            reconciledAt: '2026-07-20T21:01:00.000Z',
            baselineAccountEventId: hash('b'),
            baselineObservedAt: '2026-07-19T13:00:00.000Z',
            baselineCashMicros: '1000',
            openingAccountEventId: hash('9'),
            openingObservedAt: '2026-07-20T13:00:00.000Z',
            openingCashMicros: '1000',
            preWindowAccountedCashDeltaMicros: '0',
            preWindowCashResidualMicros: '0',
            closingAccountEventId: hash('a'),
            closingObservedAt: '2026-07-20T21:00:00.000Z',
            closingCashMicros: '2100',
            accountedCashDeltaMicros: prepared.transaction.cashDeltaMicros,
            cashYieldMicros: '200',
          },
          transactions: [prepared.transaction],
          transactionEvidence: [
            {
              transactionId: prepared.transaction.transactionId,
              cycleId,
              side: OrderSide.Sell,
              feeMicros: '0',
              realizedPnlMicros: '-100',
              occurredAt: fill.occurredAt,
            },
          ],
          receipts: [accountingReceipt],
          durableExecutionBindings: [
            {
              accountId: identityResult.success.accountId,
              accountReferenceHash: identityResult.success.identityHash,
              provider: identityResult.success.provider,
              environment: identityResult.success.environment,
              qualificationRunId,
              strategyName: 'risk-balanced-trend',
              strategyProtocolHash,
              strategyBehaviorHash: config.build.strategyBehaviorHash,
              strategyParameterHash: config.build.strategyParameterHash,
              strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
              executionPolicyHash,
              sourceRevision: config.build.sourceRevision,
              imageRepository: config.build.imageRepository,
              imageDigest: config.build.imageDigest,
            },
          ],
          unclosedCycleCount: 0,
          unresolvedMutationCount: 0,
          openPositionCount: 0,
          unaccountedFillCount: 0,
          postReconciliationActivityCount: 0,
        }),
      ledger: (_config, _accountId, _plans, cashYieldEvidence) => {
        expect(cashYieldEvidence).toEqual({
          schemaVersion: 'bayn.forward-performance-cash-yield-evidence.v1',
          reconciliationId: hash('7'),
          reconciliationContentHash: hash('8'),
          reconciledAt: '2026-07-20T21:01:00.000Z',
          baselineAccountEventId: hash('b'),
          baselineObservedAt: '2026-07-19T13:00:00.000Z',
          baselineCashMicros: '1000',
          openingAccountEventId: hash('9'),
          openingObservedAt: '2026-07-20T13:00:00.000Z',
          openingCashMicros: '1000',
          preWindowAccountedCashDeltaMicros: '0',
          preWindowCashResidualMicros: '0',
          closingAccountEventId: hash('a'),
          closingObservedAt: '2026-07-20T21:00:00.000Z',
          closingCashMicros: '2100',
          accountedCashDeltaMicros: prepared.transaction.cashDeltaMicros,
          cashYieldMicros: '200',
        })
        return Effect.succeed({
          totals: {
            realizedGainMicros: '0',
            realizedLossMicros: '100',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '200',
          },
          ledgerExact: true,
          missingLedgerAccountCount: 0,
          openPositionCount: 0,
          cashYieldEvidenceRequired: true,
          cashYieldEvidence: verifiedCashYield,
        })
      },
    }

    const receipt = await Effect.runPromise(
      Effect.scoped(runForwardPerformance(config, readers).pipe(Effect.provide(Layer.succeed(PgClient.PgClient, sql)))),
    )

    expect(receipt.schemaVersion).toBe('bayn.forward-performance-receipt.v2')
    expect(receipt.evidence).toEqual({
      status: 'SUFFICIENT',
      reasonCodes: [],
      cashYield: verifiedCashYield,
    })
    expect(receipt.profitability).toBe('PROFITABLE')
    expect(receipt.window).toMatchObject({
      reconciliationStatus: 'DISCREPANCY',
      cashYieldAdjustedExact: true,
    })
    expect(receipt.totals).toMatchObject({
      grossRealizedPnlMicros: '-100',
      cashYieldMicros: '200',
      netRealizedPnlAfterCostsMicros: '100',
      netRealizedReturn: {
        numeratorMicros: '100',
        denominatorMicros: '1000',
        decimal: '0.100000000000',
      },
    })
  })
})
