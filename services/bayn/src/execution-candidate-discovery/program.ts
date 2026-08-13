import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Option, pipe } from 'effect'

import { BrokerRead } from '../broker/alpaca'
import { CycleObservability, CycleStore, type CycleObservabilityError, type CycleStoreError } from '../cycle/store'
import type { AutonomousCycle } from '../cycle'
import type { ObserveShadowDecisionDocument } from '../shadow-decision-contract'
import {
  assetReadConcurrency,
  type ExecutionCandidateDiscoveryIdentity,
  type ExecutionCandidateDiscoveryReceipt,
  type ExecutionCandidateDiscoverySnapshot,
  type ValidatedAccount,
  type ValidatedAccountConfiguration,
  type ValidatedAssets,
  type ValidatedExecutionCandidateObservations,
  type ValidatedExecutionCandidateSnapshot,
} from './model'
import { isExecutionCandidateDiscoveryError, requireValue, type ExecutionCandidateDiscoveryError } from './failure'
import { selectCompletedCycle, validateIdentity, validateSnapshotForIdentity } from './snapshot-validation'
import {
  assembleValidatedObservations,
  validateAccountConfiguration,
  validateAccountObservation,
  validateAssetObservations,
} from './broker-observation-validation'
import { makeExecutionCandidateDiscoveryReceipt } from './receipt-construction'

const readCycle = (
  store: CycleStore['Service'],
  cycleId: string,
): Effect.Effect<AutonomousCycle, CycleStoreError | ExecutionCandidateDiscoveryError, never> =>
  pipe(
    store.read(cycleId),
    Effect.flatMap((cycle) =>
      Effect.fromResult(
        pipe(Option.getOrNull(cycle), (value) =>
          requireValue(value, {
            _tag: 'CycleMissing',
            failure: 'cycle-missing',
            source: 'cycle-store',
            cycleId,
          }),
        ),
      ),
    ),
  )

const readDecisionDocument = (
  store: CycleStore['Service'],
  cycleId: string,
): Effect.Effect<ObserveShadowDecisionDocument, CycleStoreError | ExecutionCandidateDiscoveryError, never> =>
  pipe(
    store.readDecisionDocument(cycleId),
    Effect.flatMap((document) =>
      Effect.fromResult(
        pipe(Option.getOrNull(document), (value) =>
          requireValue(value, { _tag: 'DocumentMissing', failure: 'document-missing', cycleId }),
        ),
      ).pipe(
        Effect.flatMap((stored) =>
          stored.mode === 'OBSERVE'
            ? Effect.succeed(stored)
            : Effect.fail({
                _tag: 'TargetPlanUnavailable' as const,
                failure: 'document-mismatch' as const,
                status: stored.mode,
                intentTargetCount: stored.targetPlan.intentTargets.length,
              }),
        ),
      ),
    ),
  )

const readSnapshotTransaction = (
  identity: ExecutionCandidateDiscoveryIdentity,
  observability: CycleObservability['Service'],
  store: CycleStore['Service'],
): Effect.Effect<
  ExecutionCandidateDiscoverySnapshot,
  CycleObservabilityError | CycleStoreError | ExecutionCandidateDiscoveryError
> =>
  Effect.gen(function* () {
    const projection = yield* observability.read(identity.qualificationRunId, identity.accountId)
    const last = yield* Effect.fromResult(selectCompletedCycle(projection))
    const cycle = yield* readCycle(store, last.cycleId)
    const document = yield* readDecisionDocument(store, last.cycleId)
    return { cycle, document, projection }
  })

const readDiscoverySnapshot = (
  identity: ExecutionCandidateDiscoveryIdentity,
): Effect.Effect<
  ExecutionCandidateDiscoverySnapshot,
  ExecutionCandidateDiscoveryError,
  PgClient.PgClient | CycleObservability | CycleStore
> =>
  pipe(
    Effect.all({
      sql: PgClient.PgClient,
      observability: CycleObservability,
      store: CycleStore,
    }),
    Effect.flatMap(({ observability, sql, store }) =>
      sql.withTransaction(
        pipe(
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
          Effect.andThen(readSnapshotTransaction(identity, observability, store)),
        ),
      ),
    ),
    Effect.mapError((cause) =>
      isExecutionCandidateDiscoveryError(cause)
        ? cause
        : {
            _tag: 'SnapshotTransactionFailed',
            failure: 'transaction',
            accountId: identity.accountId,
            qualificationRunId: identity.qualificationRunId,
            cause,
          },
    ),
  )

const readAccount = (
  broker: BrokerRead['Service'],
  identity: ExecutionCandidateDiscoveryIdentity,
): Effect.Effect<ValidatedAccount, ExecutionCandidateDiscoveryError> =>
  pipe(
    broker.account,
    Effect.mapError(
      (cause): ExecutionCandidateDiscoveryError => ({
        _tag: 'BrokerReadFailed',
        failure: 'broker',
        read: 'account',
        accountId: identity.accountId,
        cause,
      }),
    ),
    Effect.flatMap((account) => Effect.fromResult(validateAccountObservation(identity, account))),
  )

const readAccountConfiguration = (
  broker: BrokerRead['Service'],
  account: ValidatedAccount,
): Effect.Effect<ValidatedAccountConfiguration, ExecutionCandidateDiscoveryError> =>
  pipe(
    broker.accountConfiguration,
    Effect.mapError(
      (cause): ExecutionCandidateDiscoveryError => ({
        _tag: 'BrokerReadFailed',
        failure: 'broker',
        read: 'account-configuration',
        accountId: account.read.value.id,
        cause,
      }),
    ),
    Effect.flatMap((configuration) => Effect.fromResult(validateAccountConfiguration(account, configuration))),
  )

const readAssets = (
  broker: BrokerRead['Service'],
  snapshot: ExecutionCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
): Effect.Effect<ValidatedAssets, ExecutionCandidateDiscoveryError> =>
  pipe(
    Effect.forEach(snapshot.document.targetPlan.intentTargets, (intent) => broker.assetBySymbol(intent.symbol), {
      concurrency: assetReadConcurrency,
    }),
    Effect.mapError(
      (cause): ExecutionCandidateDiscoveryError => ({
        _tag: 'BrokerReadFailed',
        failure: 'broker',
        read: 'assets',
        accountId: snapshot.cycle.identity.accountId,
        symbols: snapshot.document.targetPlan.intentTargets.map(({ symbol }) => symbol),
        cause,
      }),
    ),
    Effect.flatMap((assets) => Effect.fromResult(validateAssetObservations(snapshot, configuration, assets))),
  )

const observeBroker = (
  validatedSnapshot: ValidatedExecutionCandidateSnapshot,
): Effect.Effect<ValidatedExecutionCandidateObservations, ExecutionCandidateDiscoveryError, BrokerRead> =>
  Effect.gen(function* () {
    const broker = yield* BrokerRead
    const account = yield* readAccount(broker, validatedSnapshot.identity)
    const accountConfiguration = yield* readAccountConfiguration(broker, account)
    const assets = yield* readAssets(broker, validatedSnapshot.snapshot, accountConfiguration)
    const capturedAtMs = yield* Clock.currentTimeMillis
    return yield* Effect.fromResult(
      assembleValidatedObservations(validatedSnapshot, account, accountConfiguration, assets, capturedAtMs),
    )
  })

export const discoverExecutionCandidates = (
  candidateIdentity: ExecutionCandidateDiscoveryIdentity,
): Effect.Effect<
  ExecutionCandidateDiscoveryReceipt,
  ExecutionCandidateDiscoveryError,
  PgClient.PgClient | CycleObservability | CycleStore | BrokerRead
> =>
  Effect.gen(function* () {
    const identity = yield* Effect.fromResult(validateIdentity(candidateIdentity))
    const snapshot = yield* readDiscoverySnapshot(identity)
    const startedAt = yield* Clock.currentTimeMillis
    const validatedSnapshot = yield* Effect.fromResult(validateSnapshotForIdentity(identity, snapshot, startedAt))
    const observations = yield* observeBroker(validatedSnapshot)
    return yield* Effect.fromResult(makeExecutionCandidateDiscoveryReceipt(validatedSnapshot, observations))
  })
