import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Option, pipe } from 'effect'

import { BrokerRead } from '../broker/alpaca'
import { CycleObservability, type CycleObservabilityError } from '../db/cycle-observability'
import { CycleStore, type CycleStoreError } from '../db/cycle-store'
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
  type ValidatedPaperCandidateObservations,
  type ValidatedPaperCandidateSnapshot,
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
  pipe(
    Effect.Do,
    Effect.bind('projection', () => observability.read(identity.qualificationRunId, identity.accountId)),
    Effect.bind('last', ({ projection }) => Effect.fromResult(selectCompletedCycle(projection))),
    Effect.bind('cycle', ({ last }) => readCycle(store, last.cycleId)),
    Effect.bind('document', ({ last }) => readDecisionDocument(store, last.cycleId)),
    Effect.map(({ cycle, document, projection }) => ({ cycle, document, projection })),
  )

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
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
): Effect.Effect<ValidatedPaperCandidateObservations, ExecutionCandidateDiscoveryError, BrokerRead> =>
  pipe(
    BrokerRead,
    Effect.flatMap((broker) =>
      pipe(
        Effect.Do,
        Effect.bind('account', () => readAccount(broker, validatedSnapshot.identity)),
        Effect.bind('accountConfiguration', ({ account }) => readAccountConfiguration(broker, account)),
        Effect.bind('assets', ({ accountConfiguration }) =>
          readAssets(broker, validatedSnapshot.snapshot, accountConfiguration),
        ),
        Effect.bind('capturedAtMs', () => Clock.currentTimeMillis),
        Effect.flatMap(({ account, accountConfiguration, assets, capturedAtMs }) =>
          Effect.fromResult(
            assembleValidatedObservations(validatedSnapshot, account, accountConfiguration, assets, capturedAtMs),
          ),
        ),
      ),
    ),
  )

export const discoverPaperCandidates = (
  candidateIdentity: ExecutionCandidateDiscoveryIdentity,
): Effect.Effect<
  ExecutionCandidateDiscoveryReceipt,
  ExecutionCandidateDiscoveryError,
  PgClient.PgClient | CycleObservability | CycleStore | BrokerRead
> =>
  pipe(
    validateIdentity(candidateIdentity),
    Effect.fromResult,
    Effect.flatMap((identity) =>
      pipe(
        Effect.Do,
        Effect.bind('snapshot', () => readDiscoverySnapshot(identity)),
        Effect.bind('startedAt', () => Clock.currentTimeMillis),
        Effect.bind('validatedSnapshot', ({ snapshot, startedAt }) =>
          Effect.fromResult(validateSnapshotForIdentity(identity, snapshot, startedAt)),
        ),
        Effect.bind('observations', ({ validatedSnapshot }) => observeBroker(validatedSnapshot)),
        Effect.flatMap(({ observations, validatedSnapshot }) =>
          Effect.fromResult(makeExecutionCandidateDiscoveryReceipt(validatedSnapshot, observations)),
        ),
      ),
    ),
  )
