import { Data, Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type { CandidateDevelopmentVerifiedSourceFiles } from '../candidate-development-command/contracts'

export const candidateDevelopmentLocalReceiptSchemaVersion = 'bayn.candidate-development-local-attempt.v3' as const

export type CandidateDevelopmentLocalErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'SOURCE_BINDING_INVALID'
  | 'RECEIPT_ALREADY_CONSUMED'
  | 'RECEIPT_RESERVATION_FAILED'
  | 'RECEIPT_FINALIZATION_FAILED'

export class CandidateDevelopmentLocalError extends Data.TaggedError('CandidateDevelopmentLocalError')<{
  readonly code: CandidateDevelopmentLocalErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CandidateDevelopmentLocalArguments {
  readonly modulePath: string
  readonly sourceManifestPath: string
  readonly runtimeMarketDataPath: string
}

export interface CandidateDevelopmentLocalSourceBinding {
  readonly candidateOrdinal: number
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly sourceManifestPath: string
  readonly sourceManifestBlobOid: string
  readonly sourceManifestSha256: string
  readonly bindingHash: string
}

export type CandidateDevelopmentLocalDecisionStatus = 'PASS' | 'HOLD_REJECT'

export type CandidateDevelopmentLocalTerminalStatus = CandidateDevelopmentLocalDecisionStatus | 'FAILED'

export interface CandidateDevelopmentLocalAttemptReceipt {
  readonly schemaVersion: typeof candidateDevelopmentLocalReceiptSchemaVersion
  readonly candidateOrdinal: number
  readonly attempt: 1
  readonly status: 'RESERVED' | CandidateDevelopmentLocalTerminalStatus
  readonly source: CandidateDevelopmentLocalSourceBinding
  readonly terminalReportHash: string | null
}

export type CandidateDevelopmentLocalTerminalOutcome =
  | {
      readonly status: CandidateDevelopmentLocalDecisionStatus
      readonly terminalReportHash: string
    }
  | {
      readonly status: 'FAILED'
      readonly terminalReportHash: null
    }

const pathArgument = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('\u0000') &&
  !value.includes('\n') &&
  !value.includes('\r')

export const parseCandidateDevelopmentLocalArguments = (
  argv: readonly string[],
): Result.Result<CandidateDevelopmentLocalArguments, CandidateDevelopmentLocalError> => {
  if (argv.length !== 3 || !argv.every(pathArgument)) {
    return Result.fail(
      new CandidateDevelopmentLocalError({
        code: 'INVALID_ARGUMENTS',
        message: 'expected exactly <module> <source-manifest> <typed-runtime-market-data.json>',
      }),
    )
  }
  const [modulePath, sourceManifestPath, runtimeMarketDataPath] = argv as readonly [string, string, string]
  return Result.succeed({ modulePath, sourceManifestPath, runtimeMarketDataPath })
}

type SourceBindingResult = Result.Result<
  CandidateDevelopmentLocalSourceBinding,
  CandidateDevelopmentLocalError | CanonicalHashFailure
>

export const bindCandidateDevelopmentLocalSource = (
  files: CandidateDevelopmentVerifiedSourceFiles,
): SourceBindingResult => {
  const candidateOrdinal = files.sourceManifest.candidateOrdinal
  if (!Number.isSafeInteger(candidateOrdinal) || candidateOrdinal < 1) {
    return Result.fail(
      new CandidateDevelopmentLocalError({
        code: 'SOURCE_BINDING_INVALID',
        message: 'candidate source manifest has an invalid ordinal',
      }),
    )
  }
  const source = {
    candidateOrdinal,
    sourceRevision: files.sourceRevision,
    modulePath: files.modulePath,
    moduleBlobOid: files.moduleBlobOid,
    moduleSha256: files.moduleSha256,
    sourceManifestPath: files.sourceManifestPath,
    sourceManifestBlobOid: files.sourceManifestBlobOid,
    sourceManifestSha256: files.sourceManifestSha256,
  }
  return Result.map(canonicalHashV1Result(source), (bindingHash) => ({ ...source, bindingHash }))
}

export const makeCandidateDevelopmentLocalReceipt = (
  source: CandidateDevelopmentLocalSourceBinding,
  status: CandidateDevelopmentLocalAttemptReceipt['status'],
  terminalReportHash: string | null = null,
): CandidateDevelopmentLocalAttemptReceipt => ({
  schemaVersion: candidateDevelopmentLocalReceiptSchemaVersion,
  candidateOrdinal: source.candidateOrdinal,
  attempt: 1,
  status,
  source,
  terminalReportHash,
})

export const makeCandidateDevelopmentLocalTerminalReceipt = (
  source: CandidateDevelopmentLocalSourceBinding,
  outcome: CandidateDevelopmentLocalTerminalOutcome,
): CandidateDevelopmentLocalAttemptReceipt =>
  makeCandidateDevelopmentLocalReceipt(source, outcome.status, outcome.terminalReportHash)

export const serializeCandidateDevelopmentLocalReceipt = (receipt: CandidateDevelopmentLocalAttemptReceipt): string =>
  `${JSON.stringify(receipt)}\n`
