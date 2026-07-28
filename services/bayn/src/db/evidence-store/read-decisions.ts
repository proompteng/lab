import { Result, Schema } from 'effect'

import { Sha256Schema, strictParseOptions } from '../../schemas'

export interface ArtifactPageRequest {
  readonly runId: string
  readonly artifactName: string
  readonly afterOrdinal: number
  readonly limit: number
}

export type EvidenceReadInputFailure =
  | { readonly _tag: 'InvalidRunId'; readonly cause: Schema.SchemaError }
  | { readonly _tag: 'InvalidArtifactName'; readonly artifactName: string }
  | { readonly _tag: 'InvalidAfterOrdinal'; readonly afterOrdinal: number }
  | { readonly _tag: 'InvalidPageLimit'; readonly limit: number }

const decodeSha256 = Schema.decodeUnknownResult(Sha256Schema, strictParseOptions)

export const decodeRunId = (runId: unknown): Result.Result<string, EvidenceReadInputFailure> =>
  Result.mapError(decodeSha256(runId), (cause): EvidenceReadInputFailure => ({ _tag: 'InvalidRunId', cause }))

export const decideArtifactPageRequest = (input: {
  readonly runId: string
  readonly artifactName: string
  readonly afterOrdinal?: number
  readonly limit: number
}): Result.Result<ArtifactPageRequest, EvidenceReadInputFailure> =>
  Result.gen(function* () {
    const runId = yield* decodeRunId(input.runId)
    if (input.artifactName.length === 0 || input.artifactName.trim() !== input.artifactName) {
      return yield* Result.fail({
        _tag: 'InvalidArtifactName',
        artifactName: input.artifactName,
      } satisfies EvidenceReadInputFailure)
    }
    const afterOrdinal = input.afterOrdinal ?? -1
    if (!Number.isInteger(afterOrdinal) || afterOrdinal < -1) {
      return yield* Result.fail({ _tag: 'InvalidAfterOrdinal', afterOrdinal } satisfies EvidenceReadInputFailure)
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      return yield* Result.fail({ _tag: 'InvalidPageLimit', limit: input.limit } satisfies EvidenceReadInputFailure)
    }
    return { runId, artifactName: input.artifactName, afterOrdinal, limit: input.limit }
  })

export const renderEvidenceReadInputFailure = (failure: EvidenceReadInputFailure): string => {
  switch (failure._tag) {
    case 'InvalidRunId':
      return `run ID is invalid: ${failure.cause.message}`
    case 'InvalidArtifactName':
      return `artifact name is invalid: ${JSON.stringify(failure.artifactName)}`
    case 'InvalidAfterOrdinal':
      return `after ordinal must be an integer greater than or equal to -1: ${failure.afterOrdinal}`
    case 'InvalidPageLimit':
      return `page limit must be between 1 and 256: ${failure.limit}`
  }
}
