import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Option, pipe } from 'effect'

import { BrokerRead } from '../broker/alpaca'
import { CycleObservability, type CycleObservabilityError } from '../db/cycle-observability'
import { CycleStore, type CycleStoreError } from '../db/cycle-store'
import type { AutonomousCycle } from '../cycle'
import type { ObserveShadowDecisionDocument } from '../shadow-decision-contract'
import type {
  PaperCandidateDiscoveryIdentity,
  PaperCandidateDiscoveryReceipt,
  PaperCandidateDiscoverySnapshot,
} from './model'
import { isPaperCandidateDiscoveryError, requireValue, type PaperCandidateDiscoveryError } from './failure'
import { selectCompletedCycle } from './snapshot-validation'
import { makeCandidateDiscovery } from './interpreter'

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

export const discoverPaperCandidates = (
  candidateIdentity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<
  PaperCandidateDiscoveryReceipt,
  PaperCandidateDiscoveryError,
  PgClient.PgClient | CycleObservability | CycleStore | BrokerRead
> =>
  Effect.gen(function* () {
    const broker = yield* BrokerRead
    return yield* makeCandidateDiscovery({
      readSnapshot: readDiscoverySnapshot,
      readAccount: broker.account,
      readAccountConfiguration: broker.accountConfiguration,
      readAssetBySymbol: broker.assetBySymbol,
      currentTimeMillis: Clock.currentTimeMillis,
    }).discover(candidateIdentity)
  })
