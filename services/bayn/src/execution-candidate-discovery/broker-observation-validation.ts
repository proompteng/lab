import { Result, pipe } from 'effect'

import {
  AssetClass,
  AssetExchange,
  AssetStatus,
  type Account,
  type AccountConfigurationObservation,
  type AssetObservation,
  type ReadEvidence,
  type ReadResult,
} from '../broker/alpaca'
import {
  PaperCandidateIneligibility,
  ReadEvidenceSchema,
  ValidatedAccountConfigurationTypeId,
  ValidatedAccountTypeId,
  ValidatedAssetsTypeId,
  ValidatedObservationsTypeId,
  type ExecutionCandidateDiscoveryIdentity,
  type ExecutionCandidateDiscoverySnapshot,
  type ValidatedAccount,
  type ValidatedAccountConfiguration,
  type ValidatedAssets,
  type ValidatedPaperCandidateObservations,
  type ValidatedPaperCandidateSnapshot,
} from './model'
import { requireCondition, requireValue, type ExecutionCandidateDiscoveryError } from './failure'
import { Pipeable } from '../pipeable'
import { utcInstantFromEpochMillisResult } from '../time'

const assetEligibilityRules = [
  [PaperCandidateIneligibility.AssetClass, (asset: AssetObservation) => asset.assetClass !== AssetClass.UsEquity],
  [PaperCandidateIneligibility.Inactive, (asset: AssetObservation) => asset.status !== AssetStatus.Active],
  [PaperCandidateIneligibility.NotTradable, (asset: AssetObservation) => !asset.tradable],
  [PaperCandidateIneligibility.NotFractionable, (asset: AssetObservation) => !asset.fractionable],
  [PaperCandidateIneligibility.Otc, (asset: AssetObservation) => asset.exchange === AssetExchange.Otc],
  [PaperCandidateIneligibility.Ipo, (asset: AssetObservation) => asset.attributes.includes('ipo')],
  [
    PaperCandidateIneligibility.PtpNoException,
    (asset: AssetObservation) => asset.attributes.includes('ptp_no_exception'),
  ],
] as const

export const assetEligibility = (
  asset: AssetObservation,
): {
  readonly eligible: boolean
  readonly reasons: ReadonlyArray<PaperCandidateIneligibility>
} => {
  const reasons = assetEligibilityRules.flatMap(([reason, applies]) => (applies(asset) ? [reason] : []))
  return { eligible: reasons.length === 0, reasons }
}

const validateReadEvidence = <A extends { readonly observedAt: string }>(
  result: ReadResult<A>,
  identity:
    | { readonly observation: 'account' | 'account-configuration'; readonly symbol: null }
    | { readonly observation: 'asset'; readonly symbol: string },
): Result.Result<ReadResult<A>, ExecutionCandidateDiscoveryError> =>
  pipe(
    requireCondition(result.value.observedAt === result.evidence.observedAt, {
      _tag: 'ObservationTimeMismatch',
      failure: 'broker',
      ...identity,
      valueObservedAt: result.value.observedAt,
      evidenceObservedAt: result.evidence.observedAt,
    }),
    Result.map(() => result),
  )

export const normalizedReadEvidence = (evidence: ReadEvidence): typeof ReadEvidenceSchema.Type => {
  const rateLimit =
    evidence.rateLimit === undefined
      ? {}
      : {
          ...(evidence.rateLimit.limit === undefined ? {} : { limit: evidence.rateLimit.limit }),
          ...(evidence.rateLimit.remaining === undefined ? {} : { remaining: evidence.rateLimit.remaining }),
          ...(evidence.rateLimit.reset === undefined ? {} : { reset: evidence.rateLimit.reset }),
          ...(evidence.rateLimit.retryAfter === undefined ? {} : { retryAfter: evidence.rateLimit.retryAfter }),
        }
  return {
    requestId: evidence.requestId,
    status: evidence.status,
    contentHash: evidence.contentHash,
    observedAt: evidence.observedAt,
    ...(Object.keys(rateLimit).length === 0 ? {} : { rateLimit }),
  }
}

const validateAccountObservationDataFirst = (
  identity: ExecutionCandidateDiscoveryIdentity,
  account: ReadResult<Account>,
): Result.Result<ValidatedAccount, ExecutionCandidateDiscoveryError> =>
  pipe(
    Result.all([
      requireCondition(account.value.id === identity.accountId, {
        _tag: 'AccountMismatch',
        failure: 'account-mismatch',
        expectedAccountId: identity.accountId,
        observedAccountId: account.value.id,
      }),
      validateReadEvidence(account, { observation: 'account', symbol: null }),
    ]),
    Result.map(() => ({ [ValidatedAccountTypeId]: true as const, read: account })),
  )

export const validateAccountObservation = Pipeable.dual(2, validateAccountObservationDataFirst)

const validateAccountConfigurationDataFirst = (
  account: ValidatedAccount,
  configuration: ReadResult<AccountConfigurationObservation>,
): Result.Result<ValidatedAccountConfiguration, ExecutionCandidateDiscoveryError> =>
  pipe(
    Result.all([
      validateReadEvidence(configuration, { observation: 'account-configuration', symbol: null }),
      requireCondition(Date.parse(configuration.value.observedAt) >= Date.parse(account.read.value.observedAt), {
        _tag: 'ObservationChronologyMismatch',
        failure: 'broker',
        earlier: 'account',
        later: 'account-configuration',
        symbol: null,
        earlierObservedAt: account.read.value.observedAt,
        laterObservedAt: configuration.value.observedAt,
      }),
    ]),
    Result.map(() => ({
      [ValidatedAccountConfigurationTypeId]: true as const,
      read: configuration,
    })),
  )

export const validateAccountConfiguration = Pipeable.dual(2, validateAccountConfigurationDataFirst)

const validateAssetObservation = (
  symbol: string,
  ordinal: number,
  accountConfigurationObservedAt: string,
  asset: ReadResult<AssetObservation> | undefined,
): Result.Result<ReadResult<AssetObservation>, ExecutionCandidateDiscoveryError> =>
  pipe(
    requireValue(asset, { _tag: 'AssetMissing', failure: 'broker', ordinal, symbol }),
    Result.flatMap((observed) =>
      pipe(
        Result.all([
          validateReadEvidence(observed, { observation: 'asset', symbol }),
          requireCondition(observed.value.requestedSymbol === symbol && observed.value.symbol === symbol, {
            _tag: 'AssetSymbolMismatch',
            failure: 'broker',
            ordinal,
            plannedSymbol: symbol,
            requestedSymbol: observed.value.requestedSymbol,
            observedSymbol: observed.value.symbol,
          }),
          requireCondition(Date.parse(observed.value.observedAt) >= Date.parse(accountConfigurationObservedAt), {
            _tag: 'ObservationChronologyMismatch',
            failure: 'broker',
            earlier: 'account-configuration',
            later: 'asset',
            symbol,
            earlierObservedAt: accountConfigurationObservedAt,
            laterObservedAt: observed.value.observedAt,
          }),
        ]),
        Result.map(() => observed),
      ),
    ),
  )

const validateAssetObservationsDataFirst = (
  snapshot: ExecutionCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
  assets: ReadonlyArray<ReadResult<AssetObservation>>,
): Result.Result<ValidatedAssets, ExecutionCandidateDiscoveryError> =>
  pipe(
    requireCondition(assets.length === snapshot.document.targetPlan.intentTargets.length, {
      _tag: 'AssetCountMismatch',
      failure: 'broker',
      expectedAssetCount: snapshot.document.targetPlan.intentTargets.length,
      observedAssetCount: assets.length,
    }),
    Result.flatMap(() =>
      pipe(
        snapshot.document.targetPlan.intentTargets.map((intent, ordinal) =>
          validateAssetObservation(intent.symbol, ordinal, configuration.read.value.observedAt, assets[ordinal]),
        ),
        Result.all,
      ),
    ),
    Result.map((reads) => ({ [ValidatedAssetsTypeId]: true as const, reads })),
  )

export const validateAssetObservations = Pipeable.dual(3, validateAssetObservationsDataFirst)

const assembleValidatedObservationsDataFirst = (
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
  account: ValidatedAccount,
  accountConfiguration: ValidatedAccountConfiguration,
  assets: ValidatedAssets,
  capturedAtMs: number,
): Result.Result<ValidatedPaperCandidateObservations, ExecutionCandidateDiscoveryError> => {
  if (!Number.isSafeInteger(capturedAtMs)) {
    return Result.fail({
      _tag: 'ObservationCaptureTimeInvalid',
      failure: 'broker',
      observedAtMs: capturedAtMs,
      cause: { _tag: 'ObservationCaptureEpochNotSafeInteger', observedAtMs: capturedAtMs },
    })
  }
  const capturedAtResult = utcInstantFromEpochMillisResult(capturedAtMs)
  if (Result.isFailure(capturedAtResult)) {
    return Result.fail({
      _tag: 'ObservationCaptureTimeInvalid',
      failure: 'broker',
      observedAtMs: capturedAtMs,
      cause: { _tag: 'ObservationCaptureEpochOutOfRange', observedAtMs: capturedAtMs },
    })
  }
  const capturedAt = capturedAtResult.success
  return pipe(
    Result.all([
      requireCondition(capturedAtMs < Date.parse(validatedSnapshot.snapshot.document.expiresAt), {
        _tag: 'DocumentStale',
        failure: 'document-stale',
        observedAtMs: capturedAtMs,
        expiresAt: validatedSnapshot.snapshot.document.expiresAt,
      }),
      pipe(
        assets.reads.map((asset) =>
          requireCondition(Date.parse(asset.value.observedAt) <= capturedAtMs, {
            _tag: 'ObservationChronologyMismatch',
            failure: 'broker',
            earlier: 'asset',
            later: 'capture',
            symbol: asset.value.symbol,
            earlierObservedAt: asset.value.observedAt,
            laterObservedAt: capturedAt,
          }),
        ),
        Result.all,
      ),
    ]),
    Result.map(() => ({
      [ValidatedObservationsTypeId]: true as const,
      account,
      accountConfiguration,
      assets,
      capturedAt,
    })),
  )
}

export const assembleValidatedObservations = Pipeable.dual(5, assembleValidatedObservationsDataFirst)

const validateExecutionCandidateDiscoveryObservationsDataFirst = (
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
  input: {
    readonly account: ReadResult<Account>
    readonly accountConfiguration: ReadResult<AccountConfigurationObservation>
    readonly assets: ReadonlyArray<ReadResult<AssetObservation>>
    readonly capturedAtMs: number
  },
): Result.Result<ValidatedPaperCandidateObservations, ExecutionCandidateDiscoveryError> =>
  pipe(
    Result.Do,
    Result.bind('account', () => validateAccountObservation(validatedSnapshot.identity, input.account)),
    Result.bind('accountConfiguration', ({ account }) =>
      validateAccountConfiguration(account, input.accountConfiguration),
    ),
    Result.bind('assets', ({ accountConfiguration }) =>
      validateAssetObservations(validatedSnapshot.snapshot, accountConfiguration, input.assets),
    ),
    Result.flatMap(({ account, accountConfiguration, assets }) =>
      assembleValidatedObservations(validatedSnapshot, account, accountConfiguration, assets, input.capturedAtMs),
    ),
  )

export const validateExecutionCandidateDiscoveryObservations = Pipeable.dual(
  2,
  validateExecutionCandidateDiscoveryObservationsDataFirst,
)
