import { pipe, Result, Schema } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'

const PerformanceSummarySchema = Schema.Struct({
  totalReturn: Schema.Finite,
  annualizedReturn: Schema.Finite,
  sharpe: Schema.Finite,
})

const Candidate6RejectionReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-research-rejection.v1'),
  candidateOrdinal: Schema.Literal(6),
  strategyName: Schema.Literal('month-end-liquidity-reversal'),
  disposition: Schema.Literal('REJECTED_DEVELOPMENT_EVIDENCE_INSUFFICIENT'),
  evaluatedImplementation: Schema.Struct({
    commit: Schema.String,
    parameterHash: Schema.String,
    executableBehaviorHash: Schema.String,
    strategyHash: Schema.String,
    preregistrationHash: Schema.String,
  }),
  dataset: Schema.Struct({
    snapshotId: Schema.String,
    publicationAsOf: Schema.String,
    developmentStart: Schema.String,
    developmentEnd: Schema.String,
    untouchedHoldoutStart: Schema.String,
    untouchedHoldoutEnd: Schema.String,
    rawManifestExportSha256: Schema.String,
    rawBarsExportSha256: Schema.String,
    rawSessionsExportSha256: Schema.String,
    boundedBarsContentHash: Schema.String,
    boundedSessionsContentHash: Schema.String,
    officialSessionCount: Schema.Int,
  }),
  methodology: Schema.Struct({
    signalPrice: Schema.Literal('finalized-adjusted-close'),
    fillPrice: Schema.Literal('next-session-open'),
    orderSizing: Schema.Literal('close-time-bounded-notional-executed-at-next-session-open'),
    confidenceIntervalMethod: Schema.Literal('deterministic-non-wrapping-moving-block-bootstrap'),
    bootstrapReplicates: Schema.Int,
    bootstrapBlockLengthSessions: Schema.Int,
  }),
  evidence: Schema.Struct({
    correctedDevelopmentReportHash: Schema.String,
    correctedDevelopmentReportFileSha256: Schema.String,
    gross: PerformanceSummarySchema,
    net: Schema.Struct({
      totalReturn: Schema.Finite,
      annualizedReturn: Schema.Finite,
      annualizedVolatility: Schema.Finite,
      sharpe: Schema.Finite,
      maximumDrawdown: Schema.Finite,
      annualTurnover: Schema.Finite,
      observationCount: Schema.Int,
      entryCount: Schema.Int,
      orderCount: Schema.Int,
      partialFillCount: Schema.Int,
      modeledCostUsd: Schema.Finite,
    }),
    buyAndHoldSpy: PerformanceSummarySchema,
    confidenceInterval: Schema.Struct({
      confidenceLevel: Schema.Literal(0.95),
      method: Schema.Literal('deterministic-moving-block-bootstrap'),
      replicates: Schema.Int,
      blockLengthSessions: Schema.Int,
      annualizedReturn: Schema.Tuple([Schema.Finite, Schema.Finite]),
      sharpe: Schema.Tuple([Schema.Finite, Schema.Finite]),
    }),
  }),
  advancementGate: Schema.Struct({
    decision: Schema.Literal('HOLD_REJECT'),
    failures: Schema.Array(
      Schema.Literals([
        'net-sharpe-does-not-exceed-buy-and-hold-spy',
        'annualized-return-confidence-interval-includes-zero',
        'sharpe-confidence-interval-includes-zero',
      ]),
    ),
    productionStrategyRetained: Schema.Literal(false),
    officialTrialAuthorized: Schema.Literal(false),
    brokerMutationEnabled: Schema.Literal(false),
    capitalEnabled: Schema.Literal(false),
    pullRequestRecommendation: Schema.Literal('CLOSE_WITHOUT_MERGE'),
  }),
  holdoutAttestation: Schema.Struct({
    status: Schema.Literal('UNTOUCHED'),
    statement: Schema.String,
  }),
  receiptHash: Schema.String,
})

export type CandidateResearchReceiptFailure =
  | { readonly _tag: 'CandidateResearchReceiptSchemaInvalid'; readonly cause: Schema.SchemaError }
  | { readonly _tag: 'CandidateResearchReceiptHashFailure'; readonly cause: CanonicalHashFailure }
  | {
      readonly _tag: 'CandidateResearchReceiptHashMismatch'
      readonly expected: string
      readonly observed: string
    }

const decodeCandidate6RejectionReceipt = Schema.decodeUnknownResult(Candidate6RejectionReceiptSchema, {
  onExcessProperty: 'error',
})

export const verifyCandidate6RejectionReceipt = (input: unknown) =>
  pipe(
    decodeCandidate6RejectionReceipt(input),
    Result.mapError(
      (cause): CandidateResearchReceiptFailure => ({ _tag: 'CandidateResearchReceiptSchemaInvalid', cause }),
    ),
    Result.flatMap((receipt) => {
      const { receiptHash, ...material } = receipt
      return pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): CandidateResearchReceiptFailure => ({ _tag: 'CandidateResearchReceiptHashFailure', cause }),
        ),
        Result.flatMap((observed) =>
          observed === receiptHash
            ? Result.succeed(receipt)
            : Result.fail<CandidateResearchReceiptFailure>({
                _tag: 'CandidateResearchReceiptHashMismatch',
                expected: receiptHash,
                observed,
              }),
        ),
      )
    }),
  )
