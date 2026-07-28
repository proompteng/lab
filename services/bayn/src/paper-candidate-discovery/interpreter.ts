import { Effect } from 'effect'

import {
  type Account,
  type AccountConfigurationObservation,
  type AssetObservation,
  type BrokerReadError,
  type ReadResult,
} from '../broker/alpaca'
import {
  assetReadConcurrency,
  type PaperCandidateDiscoveryIdentity,
  type PaperCandidateDiscoveryReceipt,
  type PaperCandidateDiscoverySnapshot,
  type ValidatedAccount,
  type ValidatedAccountConfiguration,
  type ValidatedAssets,
} from './model'
import type { PaperCandidateDiscoveryError } from './failure'
import { validateIdentity, validateSnapshotForIdentity } from './snapshot-validation'
import {
  assembleValidatedObservations,
  validateAccountConfiguration,
  validateAccountObservation,
  validateAssetObservations,
} from './broker-observation-validation'
import { makePaperCandidateDiscoveryReceipt } from './receipt-construction'

export interface CandidateDiscoveryDependencies<R = never> {
  readonly readSnapshot: (
    identity: PaperCandidateDiscoveryIdentity,
  ) => Effect.Effect<PaperCandidateDiscoverySnapshot, PaperCandidateDiscoveryError, R>
  readonly readAccount: Effect.Effect<ReadResult<Account>, BrokerReadError>
  readonly readAccountConfiguration: Effect.Effect<ReadResult<AccountConfigurationObservation>, BrokerReadError>
  readonly readAssetBySymbol: (symbol: string) => Effect.Effect<ReadResult<AssetObservation>, BrokerReadError>
  readonly currentTimeMillis: Effect.Effect<number>
}

export interface CandidateDiscovery<R = never> {
  readonly discover: (
    identity: PaperCandidateDiscoveryIdentity,
  ) => Effect.Effect<PaperCandidateDiscoveryReceipt, PaperCandidateDiscoveryError, R>
}

const readAccount = <R>(
  dependencies: CandidateDiscoveryDependencies<R>,
  identity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<ValidatedAccount, PaperCandidateDiscoveryError> =>
  dependencies.readAccount.pipe(
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

const readAccountConfiguration = <R>(
  dependencies: CandidateDiscoveryDependencies<R>,
  account: ValidatedAccount,
): Effect.Effect<ValidatedAccountConfiguration, PaperCandidateDiscoveryError> =>
  dependencies.readAccountConfiguration.pipe(
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

const readAssets = <R>(
  dependencies: CandidateDiscoveryDependencies<R>,
  snapshot: PaperCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
): Effect.Effect<ValidatedAssets, PaperCandidateDiscoveryError> =>
  Effect.forEach(
    snapshot.document.targetPlan.intentTargets,
    (intent) => dependencies.readAssetBySymbol(intent.symbol),
    { concurrency: assetReadConcurrency },
  ).pipe(
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

export const makeCandidateDiscovery = <R>(dependencies: CandidateDiscoveryDependencies<R>): CandidateDiscovery<R> => ({
  discover: (candidateIdentity) =>
    Effect.fromResult(validateIdentity(candidateIdentity)).pipe(
      Effect.flatMap((identity) =>
        Effect.gen(function* () {
          const snapshot = yield* dependencies.readSnapshot(identity)
          const startedAt = yield* dependencies.currentTimeMillis
          const validatedSnapshot = yield* Effect.fromResult(validateSnapshotForIdentity(identity, snapshot, startedAt))
          const account = yield* readAccount(dependencies, identity)
          const accountConfiguration = yield* readAccountConfiguration(dependencies, account)
          const assets = yield* readAssets(dependencies, snapshot, accountConfiguration)
          const capturedAtMs = yield* dependencies.currentTimeMillis
          const observations = yield* Effect.fromResult(
            assembleValidatedObservations(validatedSnapshot, account, accountConfiguration, assets, capturedAtMs),
          )
          return yield* Effect.fromResult(makePaperCandidateDiscoveryReceipt(validatedSnapshot, observations))
        }),
      ),
    ),
})
