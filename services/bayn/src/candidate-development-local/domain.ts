import { Data, Result, Schema } from 'effect'

import { InputManifestArtifactSchema } from '../evidence-contracts'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import {
  IsoDateSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  SourceRevisionSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  strictParseOptions,
} from '../schemas'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type InputManifest } from '../types'

export const candidateDevelopmentLocalReceiptSchemaVersion = 'bayn.candidate-development-local-attempt.v4' as const

export type CandidateDevelopmentLocalErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'SOURCE_BINDING_INVALID'
  | 'WITNESS_INVALID'
  | 'MODULE_INVALID'
  | 'DECISION_FAILED'
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

const DailyBarSchema = Schema.Struct({
  symbol: SymbolSchema,
  sessionDate: IsoDateSchema,
  open: PositiveFiniteSchema,
  high: PositiveFiniteSchema,
  low: PositiveFiniteSchema,
  close: PositiveFiniteSchema,
  volume: NonNegativeFiniteSchema,
  source: Schema.Enum(DataSource),
  sourceFeed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  publicationSchemaVersion: Schema.Enum(PublicationSchema),
}).check(
  Schema.makeFilter((bar) =>
    bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) && bar.low <= bar.high
      ? []
      : [{ path: ['low'], issue: 'must satisfy low <= min(open, close) <= max(open, close) <= high' }],
  ),
)

const CandidateDevelopmentRuntimeMarketDataWitnessSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.strategy-development-market-data-witness.v1'),
  snapshotId: Sha256Schema,
  inputManifest: InputManifestArtifactSchema,
  contentHash: Sha256Schema,
  bars: Schema.Array(DailyBarSchema).check(Schema.isMinLength(1)),
})

const CandidateDevelopmentSourceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-source-manifest.v2'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  trialHistoryHash: Sha256Schema,
  strategyName: StrictNonEmptyStringSchema,
  strategyProtocolHash: Sha256Schema,
  modulePath: StrictNonEmptyStringSchema,
  moduleSha256: Sha256Schema,
  moduleFormat: Schema.Literal('typescript-strategy-definition-v1'),
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v2'),
    snapshotId: Sha256Schema,
    inputManifestHash: Sha256Schema,
    boundedContentHash: Sha256Schema,
  }),
})

export type CandidateDevelopmentRuntimeMarketDataWitness =
  typeof CandidateDevelopmentRuntimeMarketDataWitnessSchema.Type
export type CandidateDevelopmentSourceManifest = typeof CandidateDevelopmentSourceManifestSchema.Type

export const decodeCandidateDevelopmentRuntimeMarketDataWitness = Schema.decodeUnknownResult(
  CandidateDevelopmentRuntimeMarketDataWitnessSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentSourceManifest = Schema.decodeUnknownResult(
  CandidateDevelopmentSourceManifestSchema,
  strictParseOptions,
)

export interface CandidateDevelopmentVerifiedSourceFiles {
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly sourceManifestPath: string
  readonly sourceManifestBlobOid: string
  readonly sourceManifestSha256: string
  readonly sourceManifest: CandidateDevelopmentSourceManifest
}

export interface CandidateDevelopmentLocalSourceBinding {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly trialHistoryHash: string
  readonly strategyName: string
  readonly strategyProtocolHash: string
  readonly snapshotId: string
  readonly inputManifestHash: string
  readonly boundedContentHash: string
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly sourceManifestPath: string
  readonly sourceManifestBlobOid: string
  readonly sourceManifestSha256: string
  readonly bindingHash: string
}

const SourceObjectOidSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

export const CandidateDevelopmentLocalSourceBindingSchema = Schema.Struct({
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  trialHistoryHash: Sha256Schema,
  strategyName: StrictNonEmptyStringSchema,
  strategyProtocolHash: Sha256Schema,
  snapshotId: Sha256Schema,
  inputManifestHash: Sha256Schema,
  boundedContentHash: Sha256Schema,
  sourceRevision: SourceRevisionSchema,
  modulePath: StrictNonEmptyStringSchema,
  moduleBlobOid: SourceObjectOidSchema,
  moduleSha256: Sha256Schema,
  sourceManifestPath: StrictNonEmptyStringSchema,
  sourceManifestBlobOid: SourceObjectOidSchema,
  sourceManifestSha256: Sha256Schema,
  bindingHash: Sha256Schema,
})

export const CandidateDevelopmentLocalTerminalReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-local-terminal.v1'),
  source: CandidateDevelopmentLocalSourceBindingSchema,
  status: Schema.Union([Schema.Literal('PASS'), Schema.Literal('HOLD_REJECT')]),
  evaluationHash: Sha256Schema,
  targetHash: Sha256Schema,
  qualificationAnalysisHash: Sha256Schema,
})

export type CandidateDevelopmentLocalTerminalReport = typeof CandidateDevelopmentLocalTerminalReportSchema.Type

export type CandidateDevelopmentLocalDecisionStatus = 'PASS' | 'HOLD_REJECT'
export type CandidateDevelopmentLocalTerminalStatus = CandidateDevelopmentLocalDecisionStatus | 'FAILED'

export interface CandidateDevelopmentLocalAttemptReceipt {
  readonly schemaVersion: typeof candidateDevelopmentLocalReceiptSchemaVersion
  readonly candidateOrdinal: number
  readonly attempt: 1
  readonly status: 'RESERVED' | CandidateDevelopmentLocalTerminalStatus
  readonly source: CandidateDevelopmentLocalSourceBinding
  readonly terminalReport: CandidateDevelopmentLocalTerminalReport | null
  readonly terminalReportHash: string | null
}

export type CandidateDevelopmentLocalTerminalOutcome =
  | {
      readonly status: CandidateDevelopmentLocalDecisionStatus
      readonly terminalReport: CandidateDevelopmentLocalTerminalReport
      readonly terminalReportHash: string
    }
  | {
      readonly status: 'FAILED'
      readonly terminalReport: null
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
  const [modulePath, sourceManifestPath, runtimeMarketDataPath] = argv
  if (
    argv.length !== 3 ||
    !pathArgument(modulePath) ||
    !pathArgument(sourceManifestPath) ||
    !pathArgument(runtimeMarketDataPath)
  ) {
    return Result.fail(
      new CandidateDevelopmentLocalError({
        code: 'INVALID_ARGUMENTS',
        message: 'expected exactly <module> <source-manifest> <typed-runtime-market-data.json>',
      }),
    )
  }
  return Result.succeed({ modulePath, sourceManifestPath, runtimeMarketDataPath })
}

type SourceBindingResult = Result.Result<
  CandidateDevelopmentLocalSourceBinding,
  CandidateDevelopmentLocalError | CanonicalHashFailure
>

export const bindCandidateDevelopmentLocalSource = (
  files: CandidateDevelopmentVerifiedSourceFiles,
): SourceBindingResult => {
  const source = {
    candidateOrdinal: files.sourceManifest.candidateOrdinal,
    priorTrialCount: files.sourceManifest.priorTrialCount,
    trialHistoryHash: files.sourceManifest.trialHistoryHash,
    strategyName: files.sourceManifest.strategyName,
    strategyProtocolHash: files.sourceManifest.strategyProtocolHash,
    snapshotId: files.sourceManifest.marketData.snapshotId,
    inputManifestHash: files.sourceManifest.marketData.inputManifestHash,
    boundedContentHash: files.sourceManifest.marketData.boundedContentHash,
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
  terminalReport: CandidateDevelopmentLocalTerminalReport | null = null,
): CandidateDevelopmentLocalAttemptReceipt => ({
  schemaVersion: candidateDevelopmentLocalReceiptSchemaVersion,
  candidateOrdinal: source.candidateOrdinal,
  attempt: 1,
  status,
  source,
  terminalReport,
  terminalReportHash,
})

export const makeCandidateDevelopmentLocalTerminalReport = (
  source: CandidateDevelopmentLocalSourceBinding,
  status: CandidateDevelopmentLocalDecisionStatus,
  evaluationHash: string,
  targetHash: string,
  qualificationAnalysisHash: string,
): CandidateDevelopmentLocalTerminalReport => ({
  schemaVersion: 'bayn.candidate-development-local-terminal.v1',
  source,
  status,
  evaluationHash,
  targetHash,
  qualificationAnalysisHash,
})

export const makeCandidateDevelopmentLocalTerminalReceipt = (
  source: CandidateDevelopmentLocalSourceBinding,
  outcome: CandidateDevelopmentLocalTerminalOutcome,
): CandidateDevelopmentLocalAttemptReceipt =>
  makeCandidateDevelopmentLocalReceipt(source, outcome.status, outcome.terminalReportHash, outcome.terminalReport)

export const serializeCandidateDevelopmentLocalReceipt = (receipt: CandidateDevelopmentLocalAttemptReceipt): string =>
  `${JSON.stringify(receipt)}\n`

export const makeCandidateDevelopmentLocalTerminalReportHash = (
  source: CandidateDevelopmentLocalSourceBinding,
  status: CandidateDevelopmentLocalDecisionStatus,
  evaluationHash: string,
  targetHash: string,
  qualificationAnalysisHash: string,
): Result.Result<string, CanonicalHashFailure> =>
  canonicalHashV1Result(
    makeCandidateDevelopmentLocalTerminalReport(source, status, evaluationHash, targetHash, qualificationAnalysisHash),
  )

export const witnessContentHash = (
  witness: Omit<CandidateDevelopmentRuntimeMarketDataWitness, 'contentHash'>,
): Result.Result<string, CanonicalHashFailure> => canonicalHashV1Result(witness)

export type { DailyBar, InputManifest }
