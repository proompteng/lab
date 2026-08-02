import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Result } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import type { CandidateDevelopmentNextPreregistration } from './candidate-development-calendar'
import { makeStrategyProtocolHash, type RuntimeProvenance } from './contracts'
import { canonicalHashV1Result } from './hash'
import type { MarketDataInspection } from './market-data'
import type { QualificationLock } from './qualification'
import { qualificationCandidateMain } from './qualification-candidate/program'
import { hashParameters } from './protocol'
import { prepareQualificationLock } from './startup/decisions'
import type { RiskBalancedTrendStrategyDefinition } from './strategy/risk-balanced-trend'

export type QualificationCandidateBindingFailure =
  | {
      readonly _tag: 'QualificationCandidateBindingMismatch'
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
    }
  | {
      readonly _tag: 'QualificationCandidateLockPreparationFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'QualificationCandidateBindingHashFailed'
      readonly cause: unknown
    }

export interface QualificationCandidateBindingReceipt {
  readonly schemaVersion: 'bayn.qualification-candidate-binding.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly snapshotId: string
  readonly inputManifestHash: string
  readonly finalizedSnapshotContentHash: string
  readonly boundedContentHash: string
  readonly moduleSha256: string
  readonly trialHistoryHash: string
  readonly strategyProtocolHash: string
  readonly candidateRunId: string
  readonly lockId: string
  readonly bindingHash: string
  readonly lock: QualificationLock
}

export interface QualificationCandidateRuntime {
  readonly definition: RiskBalancedTrendStrategyDefinition
  readonly provenance: RuntimeProvenance
  readonly moduleSha256: string
  readonly trialHistoryHash: string
  readonly boundedContentHash: string
}

export interface QualificationCandidateDeployment {
  readonly sourceRevision: string
  readonly image: RuntimeProvenance['image']
}

const mismatch = (
  field: string,
  expected: unknown,
  observed: unknown,
): Result.Result<never, QualificationCandidateBindingFailure> =>
  Result.fail({
    _tag: 'QualificationCandidateBindingMismatch',
    field,
    expected,
    observed,
  })

/**
 * Metadata-only candidate command used by the unattended collector before the
 * production startup path opens the durable qualification lock. It never loads
 * bars, touches TigerBeetle, or writes PostgreSQL.
 */
export const verifyQualificationCandidateBinding = (
  preregistration: CandidateDevelopmentNextPreregistration,
  candidate: QualificationCandidateRuntime,
  deployment: QualificationCandidateDeployment,
  inspection: MarketDataInspection,
  priorTrialRunIds: readonly string[],
): Result.Result<QualificationCandidateBindingReceipt, QualificationCandidateBindingFailure> =>
  Result.gen(function* () {
    if (preregistration.candidateOrdinal !== preregistration.priorTrialCount + 1) {
      return yield* mismatch(
        'preregistration.candidateOrdinal',
        preregistration.priorTrialCount + 1,
        preregistration.candidateOrdinal,
      )
    }
    if (priorTrialRunIds.length !== preregistration.priorTrialCount) {
      return yield* mismatch('database.priorTrialCount', preregistration.priorTrialCount, priorTrialRunIds.length)
    }
    if (candidate.definition.name !== candidate.provenance.strategy.name) {
      return yield* mismatch('strategy.name', candidate.definition.name, candidate.provenance.strategy.name)
    }
    if (candidate.moduleSha256 !== preregistration.moduleSha256) {
      return yield* mismatch('moduleSha256', preregistration.moduleSha256, candidate.moduleSha256)
    }
    if (candidate.provenance.strategy.behaviorHash !== candidate.moduleSha256) {
      return yield* mismatch(
        'strategy.behaviorHash',
        candidate.moduleSha256,
        candidate.provenance.strategy.behaviorHash,
      )
    }
    const parameterHash = hashParameters(candidate.definition.parameters)
    if (candidate.provenance.strategy.parameterHash !== parameterHash) {
      return yield* mismatch('strategy.parameterHash', parameterHash, candidate.provenance.strategy.parameterHash)
    }
    if (candidate.trialHistoryHash !== preregistration.priorTrialsHash) {
      return yield* mismatch('priorTrialsHash', preregistration.priorTrialsHash, candidate.trialHistoryHash)
    }
    const strategyProtocolHash = makeStrategyProtocolHash(candidate.provenance.strategy)
    if (strategyProtocolHash !== preregistration.strategyProtocolHash) {
      return yield* mismatch('strategyProtocolHash', preregistration.strategyProtocolHash, strategyProtocolHash)
    }
    if (candidate.provenance.sourceRevision !== deployment.sourceRevision) {
      return yield* mismatch('sourceRevision', deployment.sourceRevision, candidate.provenance.sourceRevision)
    }
    if (candidate.provenance.image.repository !== deployment.image.repository) {
      return yield* mismatch('image.repository', deployment.image.repository, candidate.provenance.image.repository)
    }
    if (candidate.provenance.image.digest !== deployment.image.digest) {
      return yield* mismatch('image.digest', deployment.image.digest, candidate.provenance.image.digest)
    }
    if (candidate.boundedContentHash !== preregistration.marketData.boundedContentHash) {
      return yield* mismatch(
        'marketData.boundedContentHash',
        preregistration.marketData.boundedContentHash,
        candidate.boundedContentHash,
      )
    }

    const manifest = inspection.manifest
    const snapshot = manifest.finalizedSnapshot
    for (const [field, expected, observed] of [
      ['marketData.snapshotId', preregistration.marketData.snapshotId, snapshot.snapshotId],
      [
        'marketData.finalizedSnapshotContentHash',
        preregistration.marketData.finalizedSnapshotContentHash,
        snapshot.contentHash,
      ],
      ['marketData.inputManifestHash', preregistration.marketData.inputManifestHash, manifest.hash],
    ] as const) {
      if (expected !== observed) return yield* mismatch(field, expected, observed)
    }

    const lock = yield* Result.mapError(
      prepareQualificationLock(candidate.definition, candidate.provenance, inspection, priorTrialRunIds),
      (cause): QualificationCandidateBindingFailure => ({
        _tag: 'QualificationCandidateLockPreparationFailed',
        cause,
      }),
    )
    for (const [field, expected, observed] of [
      ['lock.sourceRevision', deployment.sourceRevision, lock.sourceRevision],
      ['lock.image.repository', deployment.image.repository, lock.image.repository],
      ['lock.image.digest', deployment.image.digest, lock.image.digest],
      ['lock.protocolHash', strategyProtocolHash, lock.protocolHash],
      ['lock.data.snapshotId', preregistration.marketData.snapshotId, lock.data.snapshotId],
      ['lock.data.inputManifestHash', preregistration.marketData.inputManifestHash, lock.data.inputManifestHash],
      ['lock.data.contentHash', preregistration.marketData.finalizedSnapshotContentHash, lock.data.contentHash],
    ] as const) {
      if (expected !== observed) return yield* mismatch(field, expected, observed)
    }

    const material = {
      schemaVersion: 'bayn.qualification-candidate-binding.v1' as const,
      candidateOrdinal: preregistration.candidateOrdinal,
      priorTrialCount: preregistration.priorTrialCount,
      sourceRevision: deployment.sourceRevision,
      imageRepository: deployment.image.repository,
      imageDigest: deployment.image.digest,
      snapshotId: snapshot.snapshotId,
      inputManifestHash: manifest.hash,
      finalizedSnapshotContentHash: snapshot.contentHash,
      boundedContentHash: preregistration.marketData.boundedContentHash,
      moduleSha256: candidate.moduleSha256,
      trialHistoryHash: candidate.trialHistoryHash,
      strategyProtocolHash,
      candidateRunId: lock.candidateRunId,
      lockId: lock.lockId,
    }
    const bindingHash = yield* Result.mapError(
      canonicalHashV1Result(material),
      (cause): QualificationCandidateBindingFailure => ({
        _tag: 'QualificationCandidateBindingHashFailed',
        cause,
      }),
    )
    return { ...material, bindingHash, lock }
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    qualificationCandidateMain.pipe(Effect.provide(Layer.merge(NodeServices.layer, Reactivity.layer))),
  )
}
