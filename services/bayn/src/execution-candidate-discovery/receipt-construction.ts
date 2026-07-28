import { Result, Schema, pipe } from 'effect'

import type { Account, AccountConfigurationObservation, AssetObservation } from '../broker/alpaca'
import { Authority } from '../execution/contracts'
import { strictParseOptions } from '../schemas'
import {
  AccountConfigurationFactsSchema,
  AccountFactsSchema,
  AssetFactsSchema,
  CandidateFactsMaterialSchema,
  CandidateFactsSchema,
  DiscoveryReceiptMaterialSchema,
  DiscoveryReceiptSchema,
  candidateFactsSchemaVersion,
  discoverySchemaVersion,
  observationReceiptSchemaVersion,
  type ExecutionCandidateDiscoveryReceipt,
  type ExecutionCandidateDiscoverySnapshot,
  type ValidatedAccountConfiguration,
  type ValidatedAssets,
  type ValidatedPaperCandidateObservations,
  type ValidatedPaperCandidateSnapshot,
} from './model'
import { assetEligibility, normalizedReadEvidence } from './broker-observation-validation'
import { canonicalHashResult, requireValue, type ExecutionCandidateDiscoveryError } from './failure'

const accountFacts = (account: Account): typeof AccountFactsSchema.Type => ({
  id: account.id,
  status: account.status,
  currency: account.currency,
  cashMicros: account.cashMicros,
  equityMicros: account.equityMicros,
  buyingPowerMicros: account.buyingPowerMicros,
  accountBlocked: account.accountBlocked,
  tradingBlocked: account.tradingBlocked,
  tradeSuspendedByUser: account.tradeSuspendedByUser,
})

const accountConfigurationFacts = (
  configuration: AccountConfigurationObservation,
): typeof AccountConfigurationFactsSchema.Type => ({
  schemaVersion: configuration.schemaVersion,
  source: configuration.source,
  requestHash: configuration.requestHash,
  fractionalTrading: configuration.fractionalTrading,
  normalizedResponseHash: configuration.normalizedResponseHash,
})

const assetFacts = (asset: AssetObservation): typeof AssetFactsSchema.Type => ({
  schemaVersion: asset.schemaVersion,
  source: asset.source,
  requestedSymbol: asset.requestedSymbol,
  requestHash: asset.requestHash,
  assetId: asset.assetId,
  symbol: asset.symbol,
  assetClass: asset.assetClass,
  exchange: asset.exchange,
  status: asset.status,
  tradable: asset.tradable,
  fractionable: asset.fractionable,
  attributes: asset.attributes,
  normalizedResponseHash: asset.normalizedResponseHash,
})

const makeCandidate = (
  snapshot: ExecutionCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
  assets: ValidatedAssets,
  ordinal: number,
): Result.Result<typeof CandidateFactsSchema.Type, ExecutionCandidateDiscoveryError> => {
  const intent = snapshot.document.targetPlan.intentTargets[ordinal]
  return pipe(
    requireValue(intent, {
      _tag: 'CandidateMaterialMissing',
      failure: 'document-mismatch',
      material: 'intent',
      ordinal,
      symbol: null,
    }),
    Result.flatMap((plannedIntent) =>
      pipe(
        Result.Do,
        Result.bind('target', () =>
          requireValue(
            snapshot.document.targetPlan.targets.find((candidate) => candidate.symbol === plannedIntent.symbol),
            {
              _tag: 'CandidateMaterialMissing',
              failure: 'document-mismatch',
              material: 'target',
              ordinal,
              symbol: plannedIntent.symbol,
            },
          ),
        ),
        Result.bind('risk', () =>
          requireValue(snapshot.document.deltaRisk[ordinal], {
            _tag: 'CandidateMaterialMissing',
            failure: 'risk-mismatch',
            material: 'risk',
            ordinal,
            symbol: plannedIntent.symbol,
          }),
        ),
        Result.bind('asset', () =>
          requireValue(assets.reads[ordinal], {
            _tag: 'AssetMissing',
            failure: 'broker',
            ordinal,
            symbol: plannedIntent.symbol,
          }),
        ),
        Result.let('eligibility', ({ asset }) => assetEligibility(asset.value)),
        Result.map(({ asset, eligibility, risk, target }) => ({
          ordinal,
          observedPlanIntentId: risk.evaluation.input.intentId,
          symbol: plannedIntent.symbol,
          side: plannedIntent.side,
          orderType: plannedIntent.orderType,
          timeInForce: plannedIntent.timeInForce,
          observedPlannedQuantityMicros: plannedIntent.quantityMicros,
          observedReferencePriceMicros: target.referencePriceMicros,
          observedNotionalLimitMicros: risk.notionalLimitMicros,
          observedEvaluatedOrderNotionalMicros: risk.evaluation.metrics.orderNotionalMicros,
          observedTargetWeight: target.targetWeight,
          observedCurrentQuantityMicros: target.currentQuantityMicros,
          observedTargetQuantityMicros: target.targetQuantityMicros,
          observedRiskDecisionId: risk.evaluation.decision.decisionId,
          observedRiskInputHash: risk.evaluation.input.inputHash,
          asset: assetFacts(asset.value),
          assetEligibility: eligibility,
          fractionalTradingEligible: configuration.read.value.fractionalTrading && eligibility.eligible,
        })),
      ),
    ),
  )
}

const makeCandidates = (
  snapshot: ExecutionCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
  assets: ValidatedAssets,
): Result.Result<ReadonlyArray<typeof CandidateFactsSchema.Type>, ExecutionCandidateDiscoveryError> =>
  pipe(
    snapshot.document.targetPlan.intentTargets.map((_, ordinal) =>
      makeCandidate(snapshot, configuration, assets, ordinal),
    ),
    Result.all,
  )

const decodeReceipt = (
  material: typeof DiscoveryReceiptMaterialSchema.Type,
): Result.Result<ExecutionCandidateDiscoveryReceipt, ExecutionCandidateDiscoveryError> =>
  pipe(
    canonicalHashResult(
      material,
      (cause): ExecutionCandidateDiscoveryError => ({
        _tag: 'ReceiptHashFailed',
        failure: 'output',
        schemaVersion: material.schemaVersion,
        candidateFactsHash: material.candidateFactsHash,
        cause,
      }),
    ),
    Result.flatMap((observationReceiptHash) =>
      pipe(
        Schema.decodeUnknownResult(
          DiscoveryReceiptSchema,
          strictParseOptions,
        )({
          ...material,
          observationReceiptHash,
        }),
        Result.mapError(
          (cause): ExecutionCandidateDiscoveryError => ({
            _tag: 'ReceiptDecodeFailed',
            failure: 'output',
            schemaVersion: material.schemaVersion,
            candidateFactsHash: material.candidateFactsHash,
            cause,
          }),
        ),
      ),
    ),
  )

export const makeExecutionCandidateDiscoveryReceipt = (
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
  observations: ValidatedPaperCandidateObservations,
): Result.Result<ExecutionCandidateDiscoveryReceipt, ExecutionCandidateDiscoveryError> => {
  const { binding, snapshot } = validatedSnapshot
  return pipe(
    Result.Do,
    Result.bind('candidates', () => makeCandidates(snapshot, observations.accountConfiguration, observations.assets)),
    Result.bind('immutableBindingHash', () =>
      canonicalHashResult(
        binding,
        (cause): ExecutionCandidateDiscoveryError => ({
          _tag: 'BindingHashFailed',
          failure: 'output',
          cycleId: binding.cycle.cycleId,
          documentContentHash: binding.document.contentHash,
          cause,
        }),
      ),
    ),
    Result.bind('candidateFacts', ({ candidates, immutableBindingHash }) =>
      pipe(
        {
          schemaVersion: candidateFactsSchemaVersion,
          immutableBindingHash,
          account: accountFacts(observations.account.read.value),
          accountConfiguration: accountConfigurationFacts(observations.accountConfiguration.read.value),
          candidates,
          consistencyDelayMs: { status: 'REQUIRED_UNBOUND' as const },
        },
        Schema.decodeUnknownResult(CandidateFactsMaterialSchema, strictParseOptions),
        Result.mapError(
          (cause): ExecutionCandidateDiscoveryError => ({
            _tag: 'CandidateFactsDecodeFailed',
            failure: 'output',
            immutableBindingHash,
            candidateCount: candidates.length,
            cause,
          }),
        ),
      ),
    ),
    Result.bind('candidateFactsHash', ({ candidateFacts }) =>
      canonicalHashResult(
        candidateFacts,
        (cause): ExecutionCandidateDiscoveryError => ({
          _tag: 'CandidateFactsHashFailed',
          failure: 'output',
          immutableBindingHash: candidateFacts.immutableBindingHash,
          candidateCount: candidateFacts.candidates.length,
          cause,
        }),
      ),
    ),
    Result.flatMap(({ candidateFacts, candidateFactsHash, immutableBindingHash }) =>
      decodeReceipt({
        schemaVersion: discoverySchemaVersion,
        operation: 'PAPER_CANDIDATE_DISCOVERY',
        authority: Authority.Observe,
        dispatchable: false,
        binding,
        immutableBindingHash,
        candidateFacts,
        candidateFactsHash,
        observations: {
          account: {
            value: observations.account.read.value,
            evidence: normalizedReadEvidence(observations.account.read.evidence),
          },
          accountConfiguration: {
            value: observations.accountConfiguration.read.value,
            evidence: normalizedReadEvidence(observations.accountConfiguration.read.evidence),
          },
          assets: observations.assets.reads.map((asset, ordinal) => ({
            ordinal,
            value: asset.value,
            evidence: normalizedReadEvidence(asset.evidence),
          })),
        },
        capturedAt: observations.capturedAt,
        observationReceiptSchemaVersion,
      }),
    ),
  )
}
