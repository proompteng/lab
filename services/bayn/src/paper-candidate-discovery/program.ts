import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Option, pipe } from 'effect'

import { BrokerRead } from '../broker/alpaca'
import { CycleObservability, type CycleObservabilityError } from '../db/cycle-observability'
import { CycleStore, type CycleStoreError } from '../db/cycle-store'
import type { AutonomousCycle } from '../cycle'
import type { ObserveShadowDecisionDocument } from '../shadow-decision-contract'
import {
  assetReadConcurrency,
  type PaperCandidateDiscoveryIdentity,
  type PaperCandidateDiscoveryReceipt,
  type PaperCandidateDiscoverySnapshot,
  type ValidatedAccount,
  type ValidatedAccountConfiguration,
  type ValidatedAssets,
  type ValidatedPaperCandidateObservations,
  type ValidatedPaperCandidateSnapshot,
} from './model'
import { isPaperCandidateDiscoveryError, requireValue, type PaperCandidateDiscoveryError } from './failure'
import { selectCompletedCycle, validateIdentity, validateSnapshotForIdentity } from './snapshot-validation'
import {
  assembleValidatedObservations,
  validateAccountConfiguration,
  validateAccountObservation,
  validateAssetObservations,
} from './broker-observation-validation'
import { makePaperCandidateDiscoveryReceipt } from './receipt-construction'

const readCycle = (
  store: CycleStore['Service'],
  cycleId: string,
): Effect.Effect<AutonomousCycle, CycleStoreError | PaperCandidateDiscoveryError, never> =>
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
): Effect.Effect<ObserveShadowDecisionDocument, CycleStoreError | PaperCandidateDiscoveryError, never> =>
  pipe(
    store.readDecisionDocument(cycleId),
    Effect.flatMap((document) =>
      Effect.fromResult(
        pipe(Option.getOrNull(document), (value) =>
          requireValue(value, { _tag: 'DocumentMissing', failure: 'document-missing', cycleId }),
        ),
      ),
    ),
  )

const readSnapshotTransaction = (
  identity: PaperCandidateDiscoveryIdentity,
  observability: CycleObservability['Service'],
  store: CycleStore['Service'],
): Effect.Effect<
  PaperCandidateDiscoverySnapshot,
  CycleObservabilityError | CycleStoreError | PaperCandidateDiscoveryError
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
  identity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<
  PaperCandidateDiscoverySnapshot,
  PaperCandidateDiscoveryError,
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
      isPaperCandidateDiscoveryError(cause)
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
  identity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<ValidatedAccount, PaperCandidateDiscoveryError> =>
  pipe(
    broker.account,
    Effect.mapError(
      (cause): PaperCandidateDiscoveryError => ({
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
): Effect.Effect<ValidatedAccountConfiguration, PaperCandidateDiscoveryError> =>
  pipe(
    broker.accountConfiguration,
    Effect.mapError(
      (cause): PaperCandidateDiscoveryError => ({
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
  snapshot: PaperCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
): Effect.Effect<ValidatedAssets, PaperCandidateDiscoveryError> =>
  pipe(
    Effect.forEach(snapshot.document.targetPlan.intentTargets, (intent) => broker.assetBySymbol(intent.symbol), {
      concurrency: assetReadConcurrency,
    }),
    Effect.mapError(
      (cause): PaperCandidateDiscoveryError => ({
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
): Effect.Effect<ValidatedPaperCandidateObservations, PaperCandidateDiscoveryError, BrokerRead> =>
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
  candidateIdentity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<
  PaperCandidateDiscoveryReceipt,
  PaperCandidateDiscoveryError,
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
          Effect.fromResult(makePaperCandidateDiscoveryReceipt(validatedSnapshot, observations)),
        ),
      ),
    ),
  )
