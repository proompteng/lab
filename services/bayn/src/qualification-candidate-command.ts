import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Result } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import type { ApplicationIdentity } from './app'
import type { CandidateDevelopmentNextPreregistration } from './candidate-development-calendar'
import { canonicalHashV1Result } from './hash'
import type { MarketDataInspection } from './market-data'
import type { QualificationLock } from './qualification'
import { qualificationCandidateMain } from './qualification-candidate/program'
import { prepareQualificationLock } from './startup/decisions'

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
  readonly committedBoundedContentHash: string
  readonly compiledBoundedContentHash: string
  readonly candidateRunId: string
  readonly lockId: string
  readonly bindingHash: string
  readonly lock: QualificationLock
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
  compiledBoundedContentHash: string,
  identity: ApplicationIdentity,
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
    if (identity.strategyProtocolHash !== preregistration.strategyProtocolHash) {
      return yield* mismatch(
        'strategyProtocolHash',
        preregistration.strategyProtocolHash,
        identity.strategyProtocolHash,
      )
    }
    if (preregistration.marketData.boundedContentHash !== compiledBoundedContentHash) {
      return yield* mismatch(
        'marketData.boundedContentHash',
        compiledBoundedContentHash,
        preregistration.marketData.boundedContentHash,
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
      prepareQualificationLock(identity.strategy, inspection, priorTrialRunIds),
      (cause): QualificationCandidateBindingFailure => ({
        _tag: 'QualificationCandidateLockPreparationFailed',
        cause,
      }),
    )
    for (const [field, expected, observed] of [
      ['lock.sourceRevision', identity.config.build.sourceRevision, lock.sourceRevision],
      ['lock.image.repository', identity.config.build.imageRepository, lock.image.repository],
      ['lock.image.digest', identity.config.build.imageDigest, lock.image.digest],
      ['lock.protocolHash', identity.strategyProtocolHash, lock.protocolHash],
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
      sourceRevision: identity.config.build.sourceRevision,
      imageRepository: identity.config.build.imageRepository,
      imageDigest: identity.config.build.imageDigest,
      snapshotId: snapshot.snapshotId,
      inputManifestHash: manifest.hash,
      finalizedSnapshotContentHash: snapshot.contentHash,
      committedBoundedContentHash: preregistration.marketData.boundedContentHash,
      compiledBoundedContentHash,
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
