import { describe, expect, test } from 'bun:test'

import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Result } from 'effect'

import { prepareAccounting } from '../accounting/domain'
import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import type { LoadedRuntimeConfig } from '../config'
import { planAccountingReceipt } from '../db/execution-store/decisions'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { DiscrepancyKind, OrderSide, type Fill } from '../execution/contracts'
import { canonicalHashV1, sha256 } from '../hash'
import { readForwardPerformancePostgres } from './postgres'
import {
  bindForwardPerformanceTerminalReferencePrices,
  makeForwardPerformanceMarketVolumeEvidence,
  readForwardPerformanceMarketVolumeWithClient,
  runForwardPerformance,
  type ForwardPerformanceReaders,
} from './program'
import type { ForwardPerformanceCashYieldEvidence, ForwardPerformanceMarketVolumeRequest } from './model'

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
const marketSymbols = ['NVDA'] as const
const marketUniverseSymbolHash = sha256(marketSymbols.join(','))
const marketEvaluationStart = '2026-07-19' as const
const marketDecisionSnapshotId = hash('d')
const marketVolumeRequestBase = {
  cycleId: hash('1'),
  decisionSnapshotId: marketDecisionSnapshotId,
  decisionSnapshotAsOfSession: '2026-07-19',
  symbol: 'NVDA',
  executionSessionDate: '2026-07-20',
  windowOpenedAt: '2026-07-20T13:30:00.000Z',
  windowClosedAt: '2026-07-20T20:00:00.000Z',
  evidenceCutoffAt: '2026-07-20T21:15:00.000Z',
  universeId: 'cross-asset-taa-v1',
  universeSymbolHash: marketUniverseSymbolHash,
  symbols: marketSymbols,
  requestedStart: '2026-07-19',
  calendarVersion: 'fixture-calendar-v1',
  source: 'alpaca',
  sourceFeed: 'sip',
  adjustment: 'all',
} as const
const marketSessionMaterial = [
  {
    calendar_version: 'fixture-calendar-v1',
    session_date: '2026-07-19',
    open_time: '09:30',
    close_time: '16:00',
    timezone: 'America/New_York',
    provider: 'alpaca',
  },
  {
    calendar_version: 'fixture-calendar-v1',
    session_date: '2026-07-20',
    open_time: '09:30',
    close_time: '16:00',
    timezone: 'America/New_York',
    provider: 'alpaca',
  },
] as const
const marketBarMaterial = [
  {
    symbol: 'NVDA',
    session_date: '2026-07-19',
    adjusted_open: '99.00000000',
    adjusted_high: '101.00000000',
    adjusted_low: '98.00000000',
    adjusted_close: '100.00000000',
    adjusted_volume: '100.00000000',
    trade_count: '100',
    vwap: '99.50000000',
    provider: 'alpaca',
    source_feed: 'sip',
    adjustment: 'all',
    publication_asof: '2026-07-20',
  },
  {
    symbol: 'NVDA',
    session_date: '2026-07-20',
    adjusted_open: '101.00000000',
    adjusted_high: '104.00000000',
    adjusted_low: '100.00000000',
    adjusted_close: '103.00000000',
    adjusted_volume: '123.45678900',
    trade_count: '123',
    vwap: '102.00000000',
    provider: 'alpaca',
    source_feed: 'sip',
    adjustment: 'all',
    publication_asof: '2026-07-20',
  },
] as const
const marketBarsContentHash = canonicalHashV1(marketBarMaterial)
const marketSessionsContentHash = canonicalHashV1(marketSessionMaterial)
const marketSnapshotId = canonicalHashV1({
  schemaVersion: 'signal.adjusted-daily-snapshot.v2',
  provider: 'alpaca',
  feed: 'sip',
  adjustment: 'all',
  calendarVersion: 'fixture-calendar-v1',
  requestedStart: '2026-07-19',
  publicationAsOf: '2026-07-20',
  symbols: marketSymbols,
  barsContentHash: marketBarsContentHash,
  sessionsContentHash: marketSessionsContentHash,
  universeId: 'cross-asset-taa-v1',
  universeSymbolHash: marketUniverseSymbolHash,
})
const marketVolumeRequest: ForwardPerformanceMarketVolumeRequest = {
  ...marketVolumeRequestBase,
}
const marketManifestMaterial = {
  snapshot_id: marketSnapshotId,
  schema_version: 'signal.adjusted-daily-snapshot.v2',
  publisher_source_revision: 'a'.repeat(40),
  publisher_image_repository: 'registry.example.test/lab/signal-publisher',
  publisher_image_digest: `sha256:${'b'.repeat(64)}`,
  universe_id: 'cross-asset-taa-v1',
  universe_symbol_hash: marketUniverseSymbolHash,
  provider: 'alpaca',
  source_feed: 'sip',
  adjustment: 'all',
  calendar_version: 'fixture-calendar-v1',
  requested_start: '2026-07-19',
  publication_asof: '2026-07-20',
  first_session: '2026-07-19',
  last_session: '2026-07-20',
  symbol_count: 1,
  session_count: 2,
  bar_count: 2,
  bars_content_hash: marketBarsContentHash,
  sessions_content_hash: marketSessionsContentHash,
  finalized_at: '2026-07-20 21:05:00.000',
} as const
const marketSnapshotRows = {
  bars: marketBarMaterial.map((bar) => ({ snapshot_id: marketSnapshotId, ...bar })),
  sessions: marketSessionMaterial.map((session) => ({ snapshot_id: marketSnapshotId, ...session })),
  manifests: [
    {
      ...marketManifestMaterial,
      manifest_content_hash: canonicalHashV1(marketManifestMaterial),
    },
  ],
}

const makeMarketSnapshotRevision = (close: string, volume: string, finalizedAt: string) => {
  const bars = marketBarMaterial.map((bar) =>
    bar.session_date === '2026-07-20' ? { ...bar, adjusted_close: close, adjusted_volume: volume } : bar,
  )
  const barsContentHash = canonicalHashV1(bars)
  const snapshotId = canonicalHashV1({
    schemaVersion: 'signal.adjusted-daily-snapshot.v2',
    provider: 'alpaca',
    feed: 'sip',
    adjustment: 'all',
    calendarVersion: 'fixture-calendar-v1',
    requestedStart: '2026-07-19',
    publicationAsOf: '2026-07-20',
    symbols: marketSymbols,
    barsContentHash,
    sessionsContentHash: marketSessionsContentHash,
    universeId: 'cross-asset-taa-v1',
    universeSymbolHash: marketUniverseSymbolHash,
  })
  const manifestMaterial = {
    ...marketManifestMaterial,
    snapshot_id: snapshotId,
    bars_content_hash: barsContentHash,
    finalized_at: finalizedAt,
  }
  return {
    snapshotId,
    rows: {
      bars: bars.map((bar) => ({ snapshot_id: snapshotId, ...bar })),
      sessions: marketSessionMaterial.map((session) => ({ snapshot_id: snapshotId, ...session })),
      manifests: [
        {
          ...manifestMaterial,
          manifest_content_hash: canonicalHashV1(manifestMaterial),
        },
      ],
    },
  }
}

const newerMarketSnapshot = makeMarketSnapshotRevision('104.00000000', '999.00000000', '2026-07-20 21:10:00.000')
const marketReaderConfig = {
  ...config,
  clickhouse: {
    ...config.clickhouse,
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1' as const,
      dataStart: '2026-07-19' as const,
      dataEnd: '2026-07-20' as const,
      lookbackStart: '2026-07-19' as const,
      evaluationStart: marketEvaluationStart,
      evaluationEnd: '2026-07-20' as const,
    },
  },
}

describe('forward performance read program', () => {
  test('constructs exact immutable Signal volume evidence without rounding fractional microshares', () => {
    const first = success(
      makeForwardPerformanceMarketVolumeEvidence(marketVolumeRequest, marketSnapshotRows, marketEvaluationStart),
    )
    const second = success(
      makeForwardPerformanceMarketVolumeEvidence(marketVolumeRequest, marketSnapshotRows, marketEvaluationStart),
    )

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schemaVersion: 'bayn.forward-performance-market-volume-evidence.v1',
      cycleId: marketVolumeRequest.cycleId,
      symbol: 'NVDA',
      executionSessionDate: '2026-07-20',
      quantityMicros: '123456789',
      closePriceMicros: '103000000',
      snapshotId: marketSnapshotId,
      manifestContentHash: canonicalHashV1(marketManifestMaterial),
      barsContentHash: marketBarsContentHash,
      finalizedAt: '2026-07-20T21:05:00.000Z',
      requestedStart: '2026-07-19',
      evaluationStart: marketEvaluationStart,
      calendarVersion: 'fixture-calendar-v1',
      source: 'alpaca',
      sourceFeed: 'sip',
      adjustment: 'all',
    })
    expect(first?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('keeps tampered finalized manifest and bar evidence unavailable for capacity measurement', () => {
    const tamperedManifest = success(
      makeForwardPerformanceMarketVolumeEvidence(
        marketVolumeRequest,
        {
          ...marketSnapshotRows,
          manifests: marketSnapshotRows.manifests.map((manifest) => ({
            ...manifest,
            publisher_source_revision: 'c'.repeat(40),
          })),
        },
        marketEvaluationStart,
      ),
    )
    const tamperedBar = success(
      makeForwardPerformanceMarketVolumeEvidence(
        marketVolumeRequest,
        {
          ...marketSnapshotRows,
          bars: marketSnapshotRows.bars.map((bar) =>
            bar.session_date === '2026-07-20' ? { ...bar, adjusted_close: '102.00000000' } : bar,
          ),
        },
        marketEvaluationStart,
      ),
    )

    expect(tamperedManifest).toBeUndefined()
    expect(tamperedBar).toBeUndefined()
  })

  test('binds the earliest execution-session snapshot separately from the signal snapshot', async () => {
    interface ClickhouseParameter {
      readonly value: unknown
    }
    const queries: Array<{ readonly text: string; readonly parameters: readonly unknown[] }> = []
    const manifests = [...marketSnapshotRows.manifests, ...newerMarketSnapshot.rows.manifests]
    const sessions = [...marketSnapshotRows.sessions, ...newerMarketSnapshot.rows.sessions]
    const bars = [...marketSnapshotRows.bars, ...newerMarketSnapshot.rows.bars]
    const statement = (
      strings: TemplateStringsArray,
      ...fragments: readonly ClickhouseParameter[]
    ): Effect.Effect<readonly unknown[]> =>
      Effect.sync(() => {
        const text = strings.join('?')
        const parameters = fragments.map((fragment) => fragment.value)
        queries.push({ text, parameters })
        if (text.includes('FROM signal.snapshot_manifests_v2') && text.includes('WHERE snapshot_id')) {
          return manifests.filter((manifest) => manifest.snapshot_id === parameters[0])
        }
        if (text.includes('FROM signal.snapshot_manifests_v2 AS manifest')) {
          return text.includes('ORDER BY manifest.finalized_at ASC') ? marketSnapshotRows.manifests : []
        }
        if (text.includes('FROM signal.exchange_sessions_v1')) {
          return sessions.filter((session) => session.snapshot_id === parameters[0])
        }
        if (text.includes('FROM signal.adjusted_daily_bars_v2')) {
          return bars.filter((bar) => bar.snapshot_id === parameters[0])
        }
        return []
      })
    const client = Object.assign(statement, {
      param: (_dataType: string, value: unknown): ClickhouseParameter => ({ value }),
      withQueryId:
        (_queryId: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect,
    }) as unknown as ClickhouseClient.ClickhouseClient

    const evidence = await Effect.runPromise(
      readForwardPerformanceMarketVolumeWithClient(marketReaderConfig, [marketVolumeRequest]).pipe(
        Effect.provide(Layer.succeed(ClickhouseClient.ClickhouseClient, client)),
      ),
    )

    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      decisionSnapshotId: marketDecisionSnapshotId,
      decisionSnapshotAsOfSession: '2026-07-19',
      snapshotId: marketSnapshotId,
      closePriceMicros: '103000000',
      quantityMicros: '123456789',
    })
    expect(evidence[0]?.snapshotId).not.toBe(newerMarketSnapshot.snapshotId)
    expect(
      queries.some(
        (query) =>
          query.text.includes('FROM signal.snapshot_manifests_v2') &&
          query.text.includes('WHERE snapshot_id') &&
          query.parameters[0] === marketSnapshotId,
      ),
    ).toBe(true)
    expect(
      queries.some((query) => query.text.includes('ORDER BY manifest.finalized_at ASC, manifest.snapshot_id ASC')),
    ).toBe(true)
    const discovery = queries.find((query) =>
      query.text.includes('ORDER BY manifest.finalized_at ASC, manifest.snapshot_id ASC'),
    )
    expect(discovery?.text).toContain('manifest.finalized_at >= parseDateTime64BestEffort')
    expect(discovery?.text).toContain('manifest.finalized_at <= parseDateTime64BestEffort')
    expect(discovery?.parameters).toContain(marketVolumeRequest.windowClosedAt)
    expect(discovery?.parameters).toContain(marketVolumeRequest.evidenceCutoffAt)
    expect(queries.some((query) => query.parameters[0] === marketDecisionSnapshotId)).toBe(false)
    expect(
      queries
        .filter(
          (query) =>
            query.text.includes('FROM signal.exchange_sessions_v1') ||
            query.text.includes('FROM signal.adjusted_daily_bars_v2'),
        )
        .every((query) => query.parameters[0] === marketSnapshotId),
    ).toBe(true)
  })

  test('binds partial terminal prices independently of later broker observation order', () => {
    const marketVolume = success(
      makeForwardPerformanceMarketVolumeEvidence(marketVolumeRequest, marketSnapshotRows, marketEvaluationStart),
    )
    if (marketVolume === undefined) throw new Error('market-volume fixture failed')
    const execution = {
      cycleId: marketVolumeRequest.cycleId,
      decisionDocumentHash: hash('6'),
      decisionHash: hash('7'),
      decisionCreatedAt: '2026-07-20T13:00:00.000Z',
      intentId: hash('8'),
      accountId: identityResult.success.accountId,
      symbol: 'NVDA',
      side: 'BUY' as const,
      plannedQuantityMicros: '1000000',
      referencePriceMicros: '100000000',
      terminalOrder: {
        eventId: hash('9'),
        brokerOrderId: 'partial-broker-order',
        clientOrderId: 'partial-client-order',
        intentId: hash('8'),
        accountId: identityResult.success.accountId,
        symbol: 'NVDA',
        side: 'BUY' as const,
        quantityMicros: '1000000',
        filledQuantityMicros: '400000',
        status: 'CANCELED' as const,
        occurredAt: '2026-07-20T20:00:00.000Z',
        observedAt: '2026-07-20T21:06:00.000Z',
      },
      fills: [],
    }
    const first = success(bindForwardPerformanceTerminalReferencePrices([execution], [marketVolume]))
    const second = success(bindForwardPerformanceTerminalReferencePrices([execution], [marketVolume]))

    expect(first).toEqual(second)
    expect(first[0]?.terminalReferencePrice).toMatchObject({
      schemaVersion: 'bayn.forward-performance-terminal-reference-price.v1',
      cycleId: marketVolumeRequest.cycleId,
      symbol: 'NVDA',
      executionSessionDate: '2026-07-20',
      priceMicros: '103000000',
      observedAt: '2026-07-20T21:05:00.000Z',
      sourceEvidenceHash: marketVolume.contentHash,
    })
    expect(first[0]?.terminalReferencePrice?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('binds a blocked intent terminal price without fabricating a broker order', () => {
    const marketVolume = success(
      makeForwardPerformanceMarketVolumeEvidence(marketVolumeRequest, marketSnapshotRows, marketEvaluationStart),
    )
    if (marketVolume === undefined) throw new Error('market-volume fixture failed')
    const intentId = hash('8')
    const execution = {
      cycleId: marketVolumeRequest.cycleId,
      decisionDocumentHash: hash('6'),
      decisionHash: hash('7'),
      decisionCreatedAt: '2026-07-20T13:00:00.000Z',
      intentId,
      accountId: identityResult.success.accountId,
      symbol: 'NVDA',
      side: 'BUY' as const,
      plannedQuantityMicros: '1000000',
      referencePriceMicros: '100000000',
      intent: {
        intentId,
        accountId: identityResult.success.accountId,
        clientOrderId: 'blocked-client-order',
        cycleId: marketVolumeRequest.cycleId,
        decisionHash: hash('7'),
        symbol: 'NVDA',
        side: 'BUY' as const,
        quantityMicros: '1000000',
        terminalOutcome: 'BLOCKED' as const,
        createdAt: '2026-07-20T13:00:00.000Z',
        updatedAt: '2026-07-20T13:05:00.000Z',
      },
      fills: [],
    }

    const first = success(bindForwardPerformanceTerminalReferencePrices([execution], [marketVolume]))
    const second = success(bindForwardPerformanceTerminalReferencePrices([execution], [marketVolume]))

    expect(first).toEqual(second)
    expect(first[0]?.terminalOrder).toBeUndefined()
    expect(first[0]?.terminalReferencePrice).toMatchObject({
      schemaVersion: 'bayn.forward-performance-terminal-reference-price.v1',
      cycleId: marketVolumeRequest.cycleId,
      symbol: 'NVDA',
      priceMicros: '103000000',
      observedAt: '2026-07-20T21:05:00.000Z',
      sourceEvidenceHash: marketVolume.contentHash,
    })
  })

  test('executes only read-only PostgreSQL statements and never treats zero activity as profitable', async () => {
    const observation: SqlObservation = { statements: [] }
    const sql = makeReadOnlySql(observation)
    let observedCashYieldEvidence: ForwardPerformanceCashYieldEvidence | undefined
    const readers: ForwardPerformanceReaders = {
      postgres: readForwardPerformancePostgres,
      marketVolume: () => Effect.succeed([]),
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
    expect(
      observation.statements.some((statement) =>
        statement.includes('JOIN autonomous_cycle_shadow_decisions AS decision'),
      ),
    ).toBe(true)
    expect(
      observation.statements.some((statement) =>
        statement.includes(
          "decision.schema_version IN ('bayn.observe-shadow-decision.v1', 'bayn.paper-cycle-decision.v1')",
        ),
      ),
    ).toBe(true)
    expect(
      observation.statements.some((statement) => statement.includes('JOIN snapshot_references AS reference')),
    ).toBe(true)
    expect(observation.statements.some((statement) => statement.includes('FROM intents AS intent'))).toBe(true)
    expect(observation.statements.some((statement) => statement.includes('FROM orders AS observed_order'))).toBe(true)
    expect(observation.statements.some((statement) => statement.includes('FROM fills AS fill'))).toBe(true)
    expect(receipt.evidence.status).toBe('INSUFFICIENT_EVIDENCE')
    expect(receipt.evidence.reasonCodes).toContain('ZERO_COMPLETED_EXECUTIONS')
    expect(receipt.evidence.reasonCodes).toContain('NON_EXACT_RECONCILIATION')
    expect(receipt.evidence.reasonCodes).toContain('CASH_YIELD_EVIDENCE_GAP')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.executionQuality).toMatchObject({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'],
    })
    expect(receipt.observedCapacity).toMatchObject({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'],
    })
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

  test('scopes forward-performance PostgreSQL evidence to one PAPER authority generation', async () => {
    const observation: SqlObservation = { statements: [] }
    const evidence = await Effect.runPromise(
      readForwardPerformancePostgres(makeReadOnlySql(observation), identityResult.success.accountId, hash('9')),
    )

    expect(evidence.cycles).toEqual([])
    expect(
      observation.statements.filter((statement) => statement.includes('scope_generation.generation_hash')).length,
    ).toBeGreaterThan(10)
    expect(
      observation.statements.some(
        (statement) =>
          statement.includes('intent.authority_generation_hash = scope_generation.generation_hash') &&
          statement.includes('intent.created_at >= scope_generation.activated_at'),
      ),
    ).toBe(true)
    expect(
      observation.statements.some(
        (statement) =>
          statement.includes("scoped_decision.schema_version = 'bayn.paper-cycle-decision.v1'") &&
          statement.includes("scoped_decision.document #>> '{bindings,authorityGenerationHash}'") &&
          statement.includes('scoped_intent.authority_generation_hash = scope_generation.generation_hash'),
      ),
    ).toBe(true)
    expect(
      observation.statements.some((statement) =>
        statement.includes('cycle.submission_open_at >= scope_generation.activated_at'),
      ),
    ).toBe(false)
    expect(
      observation.statements.some((statement) =>
        statement.includes('transaction.occurred_at < next_generation.activated_at'),
      ),
    ).toBe(false)
    expect(
      observation.statements.some((statement) =>
        statement.includes('event.observed_at < next_generation.activated_at'),
      ),
    ).toBe(true)
    expect(observation.statements.some((statement) => statement.includes('first_cycle.submission_open_at'))).toBe(true)
    expect(
      observation.statements.some((statement) => statement.includes("cycle.state IN ('PENDING', 'ACTIVE', 'BLOCKED')")),
    ).toBe(true)
    expect(
      observation.statements.some(
        (statement) =>
          statement.includes('JOIN intents AS scope_intent') &&
          statement.includes('scope_intent.intent_id = transaction.intent_id') &&
          statement.includes('scope_intent.authority_generation_hash = scope_generation.generation_hash'),
      ),
    ).toBe(true)
  })

  test('does not excuse any reconciliation discrepancy beyond the exact cash-yield residual', async () => {
    const observation: SqlObservation = { statements: [] }
    const sql = makeReadOnlySql(observation, { extraReconciliationDiscrepancy: true })
    const readers: ForwardPerformanceReaders = {
      postgres: readForwardPerformancePostgres,
      marketVolume: () => Effect.succeed([]),
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
    const marketVolumeEvidence = success(
      makeForwardPerformanceMarketVolumeEvidence(marketVolumeRequest, marketSnapshotRows, marketEvaluationStart),
    )
    if (marketVolumeEvidence === undefined) throw new Error('market-volume fixture failed')
    let observedMarketVolumeRequests: readonly ForwardPerformanceMarketVolumeRequest[] | undefined
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
          executionEvidence: [],
          marketVolumeRequests: [marketVolumeRequest],
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
      marketVolume: (_config, requests) => {
        observedMarketVolumeRequests = requests
        return Effect.succeed([marketVolumeEvidence])
      },
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

    expect(receipt.schemaVersion).toBe('bayn.forward-performance-receipt.v3')
    expect(observedMarketVolumeRequests).toEqual([marketVolumeRequest])
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
