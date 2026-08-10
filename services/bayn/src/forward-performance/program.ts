import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Redacted, Result, Scope } from 'effect'

import type { LoadedRuntimeConfig } from '../config'
import { verifyAccountingReceipts } from '../db/reconciliation-algebra'
import { type ReconciliationAlgebraFailure } from '../db/reconciliation-algebra'
import type { CanonicalJsonFailure } from '../hash'
import { canonicalHashV1Result } from '../hash'
import type { MarketDataSnapshot, SnapshotRequest } from '../market-data'
import { makeMarketDataQueries } from '../market-data/queries'
import { decodeSnapshotRows, type SnapshotRows } from '../market-data/rows'
import { verifyFinalizedSnapshot } from '../market-data-verification'
import type { BrokerIdentity } from '../broker/identity'
import type { IsoDate } from '../schemas'
import { makeForwardPerformanceReceipt, type ForwardPerformanceDomainFailure } from './domain'
import {
  readForwardPerformancePostgres,
  type ForwardPerformancePostgresEvidence,
  type ForwardPerformancePostgresError,
} from './postgres'
import {
  readForwardPerformanceLedger,
  type ForwardPerformanceLedgerEvidence,
  type ForwardPerformanceLedgerError,
} from './tigerbeetle'
import type { LedgerPlan } from '../ledger-plan'
import type {
  ForwardPerformanceCashYieldEvidence,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceMarketVolumeEvidence,
  ForwardPerformanceMarketVolumeRequest,
  ForwardPerformanceReceipt,
} from './model'
import { Pipeable } from '../pipeable'

export type ForwardPerformanceProgramCause =
  | CanonicalJsonFailure
  | ForwardPerformanceDomainFailure
  | ForwardPerformanceLedgerError
  | ForwardPerformanceMarketVolumeError
  | ForwardPerformancePostgresError
  | ReconciliationAlgebraFailure

export class ForwardPerformanceProgramError extends Data.TaggedError('ForwardPerformanceProgramError')<{
  readonly operation: 'account-binding' | 'construct-receipt' | 'ledger-read' | 'market-volume-read' | 'postgres-read'
  readonly message: string
  readonly cause?: ForwardPerformanceProgramCause
}> {}

export class ForwardPerformanceMarketVolumeError extends Data.TaggedError('ForwardPerformanceMarketVolumeError')<{
  readonly operation: 'read'
  readonly message: string
  readonly cause: unknown
}> {}

type BoundForwardPerformanceConfig = LoadedRuntimeConfig & {
  readonly execution: LoadedRuntimeConfig['execution'] & { readonly brokerIdentity: BrokerIdentity }
}

export interface ForwardPerformanceReaders {
  readonly postgres: (
    sql: PgClient.PgClient,
    accountId: string,
    authorityGenerationHash?: string,
  ) => Effect.Effect<ForwardPerformancePostgresEvidence, ForwardPerformancePostgresError>
  readonly ledger: (
    config: Pick<LoadedRuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
    accountId: string,
    accountPlans: readonly LedgerPlan[],
    cashYieldEvidence?: ForwardPerformanceCashYieldEvidence,
    generationPlans?: readonly LedgerPlan[],
  ) => Effect.Effect<ForwardPerformanceLedgerEvidence, ForwardPerformanceLedgerError, Scope.Scope>
  readonly marketVolume: (
    config: Pick<LoadedRuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
    requests: readonly ForwardPerformanceMarketVolumeRequest[],
  ) => Effect.Effect<readonly ForwardPerformanceMarketVolumeEvidence[], ForwardPerformanceMarketVolumeError>
}

export const liveForwardPerformanceReaders: ForwardPerformanceReaders = {
  postgres: readForwardPerformancePostgres,
  ledger: (config, accountId, accountPlans, cashYieldEvidence, generationPlans) =>
    readForwardPerformanceLedger(config, accountId, accountPlans, cashYieldEvidence, undefined, generationPlans),
  marketVolume: (config, requests) => readForwardPerformanceMarketVolume(config, requests),
}

const SIGNED_I128_MAX = (1n << 127n) - 1n

const marketVolumeError = (cause: unknown): ForwardPerformanceMarketVolumeError =>
  new ForwardPerformanceMarketVolumeError({
    operation: 'read',
    message: 'forward-performance immutable market-volume read failed',
    cause,
  })

const fixedDecimalMicros = (value: string): string | undefined => {
  const match = /^(0|[1-9][0-9]*)[.]([0-9]{8})$/.exec(value)
  if (match === null || match[1] === undefined || match[2] === undefined || !match[2].endsWith('00')) return undefined
  const micros = BigInt(match[1]) * 1_000_000n + BigInt(match[2].slice(0, 6))
  return micros > 0n && micros <= SIGNED_I128_MAX ? micros.toString() : undefined
}

const finalizedInstant = (value: string): string | undefined => {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:[.]([0-9]{3}))?$/.exec(value)
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const instant = `${match[1]}T${match[2]}.${match[3] ?? '000'}Z`
  return Number.isFinite(Date.parse(instant)) && new Date(instant).toISOString() === instant ? instant : undefined
}

interface ForwardPerformanceMarketSnapshotRows {
  readonly bars: readonly unknown[]
  readonly sessions: readonly unknown[]
  readonly manifests: readonly unknown[]
}

interface VerifiedForwardPerformanceMarketSnapshot {
  readonly rows: SnapshotRows
  readonly snapshot: MarketDataSnapshot
}

const snapshotRequest = (
  request: ForwardPerformanceMarketVolumeRequest,
  rows: SnapshotRows,
  evaluationStart: IsoDate,
): SnapshotRequest | undefined => {
  const manifest = rows.manifests[0]
  if (
    rows.manifests.length !== 1 ||
    manifest === undefined ||
    manifest.snapshot_id === request.decisionSnapshotId ||
    request.decisionSnapshotAsOfSession >= request.executionSessionDate
  ) {
    return undefined
  }
  const observedAt = finalizedInstant(manifest.finalized_at)
  if (observedAt === undefined || observedAt < request.windowClosedAt || observedAt > request.evidenceCutoffAt) {
    return undefined
  }
  return {
    snapshotId: manifest.snapshot_id,
    publicationAsOf: request.executionSessionDate,
    calendarVersion: request.calendarVersion,
    universe: request.symbols,
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: request.requestedStart,
      dataEnd: request.executionSessionDate,
      lookbackStart: request.requestedStart,
      evaluationStart,
      evaluationEnd: request.executionSessionDate,
    },
    observedAt,
    universeId: request.universeId,
    universeSymbolHash: request.universeSymbolHash,
    historyStart: request.requestedStart,
    evaluationStart,
  }
}

const verifyForwardPerformanceMarketSnapshot = (
  request: ForwardPerformanceMarketVolumeRequest,
  rawRows: ForwardPerformanceMarketSnapshotRows,
  evaluationStart: IsoDate,
): VerifiedForwardPerformanceMarketSnapshot | undefined => {
  const decoded = decodeSnapshotRows(rawRows.bars, rawRows.sessions, rawRows.manifests)
  if (Result.isFailure(decoded)) return undefined
  const verificationRequest = snapshotRequest(request, decoded.success, evaluationStart)
  if (verificationRequest === undefined) return undefined
  const verified = verifyFinalizedSnapshot(decoded.success, verificationRequest)
  if (Result.isFailure(verified)) return undefined
  const source = verified.success.manifest.finalizedSnapshot
  if (
    source.snapshotId === request.decisionSnapshotId ||
    source.source !== request.source ||
    source.sourceFeed !== request.sourceFeed ||
    source.adjustment !== request.adjustment ||
    source.calendarVersion !== request.calendarVersion ||
    source.asOfSession !== request.executionSessionDate ||
    source.universeId !== request.universeId ||
    source.universeSymbolHash !== request.universeSymbolHash ||
    source.requestedStart !== request.requestedStart
  ) {
    return undefined
  }
  return { rows: decoded.success, snapshot: verified.success }
}

const projectForwardPerformanceMarketVolumeEvidence = (
  request: ForwardPerformanceMarketVolumeRequest,
  verified: VerifiedForwardPerformanceMarketSnapshot,
  evaluationStart: IsoDate,
): Result.Result<ForwardPerformanceMarketVolumeEvidence | undefined, ForwardPerformanceMarketVolumeError> => {
  const matchingBars = verified.rows.bars.filter(
    (bar) => bar.symbol === request.symbol && bar.session_date === request.executionSessionDate,
  )
  const row = matchingBars.length === 1 ? matchingBars[0] : undefined
  if (row === undefined) return Result.succeed(undefined)
  const quantityMicros = fixedDecimalMicros(row.adjusted_volume)
  const closePriceMicros = fixedDecimalMicros(row.adjusted_close)
  if (quantityMicros === undefined || closePriceMicros === undefined) return Result.succeed(undefined)
  const source = verified.snapshot.manifest.finalizedSnapshot
  const material = {
    schemaVersion: 'bayn.forward-performance-market-volume-evidence.v1' as const,
    cycleId: request.cycleId,
    decisionSnapshotId: request.decisionSnapshotId,
    decisionSnapshotAsOfSession: request.decisionSnapshotAsOfSession,
    symbol: request.symbol,
    executionSessionDate: request.executionSessionDate,
    windowOpenedAt: request.windowOpenedAt,
    windowClosedAt: request.windowClosedAt,
    evidenceCutoffAt: request.evidenceCutoffAt,
    quantityMicros,
    closePriceMicros,
    snapshotId: source.snapshotId,
    manifestContentHash: source.publicationId,
    barsContentHash: source.contentHash,
    finalizedAt: source.finalizedAt,
    universeId: request.universeId,
    universeSymbolHash: request.universeSymbolHash,
    requestedStart: request.requestedStart,
    evaluationStart,
    calendarVersion: request.calendarVersion,
    source: request.source,
    sourceFeed: request.sourceFeed,
    adjustment: request.adjustment,
  }
  return Result.mapError(
    Result.map(canonicalHashV1Result(material), (contentHash) => ({ ...material, contentHash })),
    marketVolumeError,
  )
}

const makeForwardPerformanceMarketVolumeEvidenceDataFirst = (
  request: ForwardPerformanceMarketVolumeRequest,
  rows: ForwardPerformanceMarketSnapshotRows,
  evaluationStart: IsoDate,
): Result.Result<ForwardPerformanceMarketVolumeEvidence | undefined, ForwardPerformanceMarketVolumeError> => {
  const verified = verifyForwardPerformanceMarketSnapshot(request, rows, evaluationStart)
  return verified === undefined
    ? Result.succeed(undefined)
    : projectForwardPerformanceMarketVolumeEvidence(request, verified, evaluationStart)
}

export const makeForwardPerformanceMarketVolumeEvidence = Pipeable.dual(
  3,
  makeForwardPerformanceMarketVolumeEvidenceDataFirst,
)

const requestGroupKey = (request: ForwardPerformanceMarketVolumeRequest): string =>
  JSON.stringify([
    request.decisionSnapshotId,
    request.decisionSnapshotAsOfSession,
    request.executionSessionDate,
    request.evidenceCutoffAt,
    request.universeId,
    request.universeSymbolHash,
    request.symbols,
    request.requestedStart,
    request.calendarVersion,
    request.source,
    request.sourceFeed,
    request.adjustment,
  ])

const groupMarketVolumeRequests = (
  requests: readonly ForwardPerformanceMarketVolumeRequest[],
): readonly (readonly ForwardPerformanceMarketVolumeRequest[])[] => {
  const groups = new Map<string, ForwardPerformanceMarketVolumeRequest[]>()
  for (const request of requests) {
    const key = requestGroupKey(request)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [request])
    else group.push(request)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, group]) => group)
}

const readForwardPerformanceMarketVolumeWithClientDataFirst = (
  config: Pick<LoadedRuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  requests: readonly ForwardPerformanceMarketVolumeRequest[],
): Effect.Effect<
  readonly ForwardPerformanceMarketVolumeEvidence[],
  ForwardPerformanceMarketVolumeError,
  ClickhouseClient.ClickhouseClient
> => {
  if (requests.length === 0) return Effect.succeed([])
  return Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    const groups = yield* Effect.forEach(
      groupMarketVolumeRequests(requests),
      (group) =>
        Effect.gen(function* () {
          const request = group[0]
          if (request === undefined) return []
          const queries = makeMarketDataQueries(sql, config, {
            universeId: request.universeId,
            universeSymbolHash: request.universeSymbolHash,
            universe: request.symbols,
            historyStart: request.requestedStart,
            evaluationStart: config.clickhouse.bounds.evaluationStart,
          })
          const candidateRows = yield* sql<Record<string, unknown>>`
            SELECT
              snapshot_id,
              schema_version,
              publisher_source_revision,
              publisher_image_repository,
              publisher_image_digest,
              universe_id,
              universe_symbol_hash,
              provider,
              source_feed,
              adjustment,
              calendar_version,
              toString(requested_start) AS requested_start,
              toString(publication_asof) AS publication_asof,
              toString(first_session) AS first_session,
              toString(last_session) AS last_session,
              symbol_count,
              session_count,
              bar_count,
              bars_content_hash,
              sessions_content_hash,
              manifest_content_hash,
              toString(finalized_at) AS finalized_at
            FROM signal.snapshot_manifests_v2 AS manifest
            WHERE manifest.universe_id = ${sql.param('String', request.universeId)}
              AND manifest.universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
              AND manifest.requested_start = toDate(${sql.param('String', request.requestedStart)})
              AND manifest.publication_asof = toDate(${sql.param('String', request.executionSessionDate)})
              AND manifest.calendar_version = ${sql.param('String', request.calendarVersion)}
              AND manifest.provider = ${sql.param('String', request.source)}
              AND manifest.source_feed = ${sql.param('String', request.sourceFeed)}
              AND manifest.adjustment = ${sql.param('String', request.adjustment)}
              AND manifest.finalized_at >= parseDateTime64BestEffort(${sql.param('String', request.windowClosedAt)})
              AND manifest.finalized_at <= parseDateTime64BestEffort(${sql.param('String', request.evidenceCutoffAt)})
            ORDER BY manifest.finalized_at ASC, manifest.snapshot_id ASC
            LIMIT 1
          `
          const decodedCandidates = decodeSnapshotRows([], [], candidateRows)
          if (Result.isFailure(decodedCandidates)) return []
          const candidate = decodedCandidates.success.manifests[0]
          if (
            decodedCandidates.success.manifests.length !== 1 ||
            candidate === undefined ||
            candidate.snapshot_id === request.decisionSnapshotId
          ) {
            return []
          }
          const manifests = yield* queries.loadSnapshotPublicationManifest({
            snapshotId: candidate.snapshot_id,
            signalSessionDate: request.executionSessionDate,
            signalCalendarVersion: request.calendarVersion,
          })
          const decodedManifests = decodeSnapshotRows([], [], manifests)
          if (Result.isFailure(decodedManifests)) return []
          const manifest = decodedManifests.success.manifests[0]
          if (
            decodedManifests.success.manifests.length !== 1 ||
            manifest === undefined ||
            manifest.snapshot_id !== candidate.snapshot_id ||
            manifest.manifest_content_hash !== candidate.manifest_content_hash
          ) {
            return []
          }
          const rows = yield* Effect.all(
            {
              bars: queries.loadSnapshotPublicationBars(candidate.snapshot_id),
              sessions: queries.loadPublicationSessions(candidate.snapshot_id),
            },
            { concurrency: 2 },
          )
          const verified = verifyForwardPerformanceMarketSnapshot(
            request,
            { bars: rows.bars, sessions: rows.sessions, manifests },
            config.clickhouse.bounds.evaluationStart,
          )
          if (verified === undefined) return []
          const projected = yield* Effect.forEach(group, (item) =>
            Effect.fromResult(
              projectForwardPerformanceMarketVolumeEvidence(item, verified, config.clickhouse.bounds.evaluationStart),
            ),
          )
          return projected.filter((item): item is ForwardPerformanceMarketVolumeEvidence => item !== undefined)
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof ForwardPerformanceMarketVolumeError ? cause : marketVolumeError(cause),
          ),
        ),
      { concurrency: 2 },
    )
    return groups.flat().sort((left, right) => {
      const leftKey = JSON.stringify([left.executionSessionDate, left.cycleId, left.symbol])
      const rightKey = JSON.stringify([right.executionSessionDate, right.cycleId, right.symbol])
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ForwardPerformanceMarketVolumeError ? cause : marketVolumeError(cause),
    ),
  )
}

export const readForwardPerformanceMarketVolumeWithClient = Pipeable.dual(
  2,
  readForwardPerformanceMarketVolumeWithClientDataFirst,
)

const readForwardPerformanceMarketVolumeDataFirst = (
  config: Pick<LoadedRuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  requests: readonly ForwardPerformanceMarketVolumeRequest[],
): Effect.Effect<readonly ForwardPerformanceMarketVolumeEvidence[], ForwardPerformanceMarketVolumeError> => {
  if (requests.length === 0) return Effect.succeed([])
  const client = ClickhouseClient.layer({
    url: config.clickhouse.url,
    username: config.clickhouse.username,
    password: Redacted.value(config.clickhouse.password),
    database: 'signal',
    application: 'bayn-forward-performance',
    request_timeout: config.operationTimeoutMs,
  })
  return Effect.scoped(
    // @effect-diagnostics-next-line strictEffectProvide:off -- scoped ClickHouse query boundary owns the client layer
    readForwardPerformanceMarketVolumeWithClient(config, requests).pipe(Effect.provide(client)),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof ForwardPerformanceMarketVolumeError ? cause : marketVolumeError(cause),
    ),
  )
}

export const readForwardPerformanceMarketVolume = Pipeable.dual(2, readForwardPerformanceMarketVolumeDataFirst)

const canonicalUnsigned = (value: string): bigint | undefined =>
  /^(?:0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined

const bindForwardPerformanceTerminalReferencePricesDataFirst = (
  executionEvidence: readonly ForwardPerformanceExecutionEvidence[],
  marketVolumeEvidence: readonly ForwardPerformanceMarketVolumeEvidence[],
): Result.Result<readonly ForwardPerformanceExecutionEvidence[], CanonicalJsonFailure> => {
  const volumes = new Map<string, ForwardPerformanceMarketVolumeEvidence | null>()
  for (const volume of marketVolumeEvidence) {
    const key = JSON.stringify([volume.cycleId, volume.symbol])
    volumes.set(key, volumes.has(key) ? null : volume)
  }
  return Result.all(
    executionEvidence.map((execution) => {
      const order = execution.terminalOrder
      const orderQuantity = order === undefined ? undefined : canonicalUnsigned(order.quantityMicros)
      const filledQuantity = order === undefined ? undefined : canonicalUnsigned(order.filledQuantityMicros)
      const blockedAt =
        execution.intent?.terminalOutcome === 'BLOCKED' && order === undefined && execution.fills.length === 0
          ? execution.intent.updatedAt
          : undefined
      const incompleteOrder =
        order !== undefined &&
        ['CANCELED', 'EXPIRED', 'REJECTED'].includes(order.status) &&
        orderQuantity !== undefined &&
        filledQuantity !== undefined &&
        filledQuantity < orderQuantity
          ? order
          : undefined
      const terminalOccurredAt = blockedAt ?? incompleteOrder?.occurredAt
      const terminalObservedAt = blockedAt ?? incompleteOrder?.observedAt
      if (terminalOccurredAt === undefined || terminalObservedAt === undefined) {
        return Result.succeed(execution)
      }
      const volume = volumes.get(JSON.stringify([execution.cycleId, execution.symbol]))
      if (volume === undefined || volume === null) {
        return Result.succeed(execution)
      }
      const terminalWithinExecutionWindow =
        blockedAt === undefined
          ? terminalOccurredAt >= volume.windowOpenedAt && terminalOccurredAt <= volume.windowClosedAt
          : terminalOccurredAt <= volume.windowClosedAt
      if (!terminalWithinExecutionWindow || terminalObservedAt > volume.evidenceCutoffAt) {
        return Result.succeed(execution)
      }
      const material = {
        schemaVersion: 'bayn.forward-performance-terminal-reference-price.v1' as const,
        cycleId: execution.cycleId,
        symbol: execution.symbol,
        executionSessionDate: volume.executionSessionDate,
        priceMicros: volume.closePriceMicros,
        observedAt: volume.finalizedAt,
        sourceEvidenceHash: volume.contentHash,
      }
      return Result.map(canonicalHashV1Result(material), (contentHash) => ({
        ...execution,
        terminalReferencePrice: { ...material, contentHash },
      }))
    }),
  )
}

export const bindForwardPerformanceTerminalReferencePrices = Pipeable.dual(
  2,
  bindForwardPerformanceTerminalReferencePricesDataFirst,
)

const programError = (
  operation: ForwardPerformanceProgramError['operation'],
  message: string,
  cause?: ForwardPerformanceProgramCause,
): ForwardPerformanceProgramError =>
  new ForwardPerformanceProgramError({ operation, message, ...(cause === undefined ? {} : { cause }) })

const requireBrokerIdentity = (
  config: LoadedRuntimeConfig,
): Effect.Effect<BoundForwardPerformanceConfig, ForwardPerformanceProgramError> => {
  const brokerIdentity = config.execution.brokerIdentity
  return brokerIdentity === undefined
    ? Effect.fail(
        programError('account-binding', 'forward performance requires one configured broker account identity'),
      )
    : Effect.succeed(config as BoundForwardPerformanceConfig)
}

const runForwardPerformanceDataFirst = (
  loadedConfig: LoadedRuntimeConfig,
  readers: ForwardPerformanceReaders = liveForwardPerformanceReaders,
  options: { readonly authorityGenerationHash?: string } = {},
): Effect.Effect<ForwardPerformanceReceipt, ForwardPerformanceProgramError, PgClient.PgClient | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* requireBrokerIdentity(loadedConfig)
    const identity = config.execution.brokerIdentity
    const sql = yield* PgClient.PgClient
    const postgres = yield* readers
      .postgres(sql, identity.accountId, options.authorityGenerationHash)
      .pipe(Effect.mapError((cause) => programError('postgres-read', cause.message, cause)))
    const marketVolumeEvidence = yield* readers
      .marketVolume(config, postgres.marketVolumeRequests)
      .pipe(Effect.mapError((cause) => programError('market-volume-read', cause.message, cause)))
    const executionEvidence = yield* Effect.fromResult(
      bindForwardPerformanceTerminalReferencePrices(postgres.executionEvidence, marketVolumeEvidence),
    ).pipe(
      Effect.mapError((cause) =>
        programError('construct-receipt', 'forward-performance terminal reference binding failed', cause),
      ),
    )

    const accountingVerification = verifyAccountingReceipts(postgres.transactions, postgres.receipts, config)
    const generationPlans = Result.isSuccess(accountingVerification) ? accountingVerification.success.plans : []
    const ledgerVerification = verifyAccountingReceipts(postgres.ledgerTransactions, postgres.ledgerReceipts, config)
    const accountPlans = Result.isSuccess(ledgerVerification) ? ledgerVerification.success.plans : []
    const accountingReceiptsExact =
      Result.isSuccess(accountingVerification) &&
      postgres.unaccountedFillCount === 0 &&
      accountingVerification.success.exactReceipts.size === postgres.transactions.length &&
      [...accountingVerification.success.exactReceipts.values()].every(Boolean)

    const ledger = yield* readers
      .ledger(config, identity.accountId, accountPlans, postgres.cashYieldEvidence, generationPlans)
      .pipe(Effect.mapError((cause) => programError('ledger-read', cause.message, cause)))
    const reconciliation =
      postgres.reconciliation === undefined
        ? undefined
        : {
            ...postgres.reconciliation,
            performanceExact:
              postgres.reconciliation.performanceExact &&
              (!postgres.reconciliation.cashYieldAdjustedExact || ledger.cashYieldEvidence !== undefined),
            cashYieldAdjustedExact:
              postgres.reconciliation.cashYieldAdjustedExact && ledger.cashYieldEvidence !== undefined,
          }
    const receipt = yield* Effect.fromResult(
      makeForwardPerformanceReceipt({
        runtime: {
          sourceRevision: config.build.sourceRevision,
          imageRepository: config.build.imageRepository,
          imageDigest: config.build.imageDigest,
        },
        account: {
          accountId: identity.accountId,
          accountReferenceHash: identity.identityHash,
          provider: identity.provider,
          environment: identity.environment,
        },
        durableExecutionBindings: postgres.durableExecutionBindings,
        cycles: postgres.cycles,
        ...(postgres.strategy === undefined ? {} : { strategy: postgres.strategy }),
        ...(reconciliation === undefined ? {} : { reconciliation }),
        ...(postgres.startingCapitalMicros === undefined
          ? {}
          : { startingCapitalMicros: postgres.startingCapitalMicros }),
        transactions: postgres.transactionEvidence,
        executionEvidence,
        marketVolumeEvidence,
        ledgerTotals: ledger.totals,
        cashYieldEvidenceRequired: ledger.cashYieldEvidenceRequired,
        ...(ledger.cashYieldEvidence === undefined ? {} : { cashYieldEvidence: ledger.cashYieldEvidence }),
        accountingReceiptsExact,
        ledgerExact: ledger.ledgerExact,
        missingLedgerAccountCount: ledger.missingLedgerAccountCount,
        unresolvedMutationCount: postgres.unresolvedMutationCount,
        unclosedCycleCount: postgres.unclosedCycleCount + postgres.postReconciliationActivityCount,
        openPositionCount: Math.max(postgres.openPositionCount, ledger.openPositionCount),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        programError('construct-receipt', 'forward-performance receipt construction failed', cause),
      ),
    )
    return receipt
  })

export const runForwardPerformance = Pipeable.by<
  (
    readers?: ForwardPerformanceReaders,
    options?: { readonly authorityGenerationHash?: string },
  ) => (loadedConfig: LoadedRuntimeConfig) => ReturnType<typeof runForwardPerformanceDataFirst>,
  typeof runForwardPerformanceDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'runtimeMode' in arguments_[0],
  runForwardPerformanceDataFirst,
)
