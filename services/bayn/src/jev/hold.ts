import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevContractError } from './contract'
import {
  JevPositionEvidenceSchema,
  jevBrokerEvidenceFreshUntilMs,
  jevMaximumHoldDueAt,
  jevProtectiveStopCrossed,
  validateJevPositionEvidence,
  verifiedPositionQuote,
} from './exit'
import { JevObservationSchema } from './observation-contract'
import { jevProfitTargetCrossed } from './profit-target'

export const JevPositionHoldEvidenceSchema = Schema.Struct({
  ...JevPositionEvidenceSchema.fields,
  authorityGenerationHash: Sha256Schema,
  source: Schema.Struct({
    manifest: JevObservationSchema.fields.manifest,
    rows: JevObservationSchema.fields.rows,
  }),
})

/** Reproduce a strategy hold from the same owned position and executable quote required for an exit. */
export const decideJevPositionHold = (input: unknown) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(JevPositionHoldEvidenceSchema, strictParseOptions)(input)
    const { portfolio, position, firstFill, entryPlan, now } = yield* validateJevPositionEvidence(evidence)
    const holdDue = jevMaximumHoldDueAt(firstFill.occurredAt, portfolio.exitPolicy.maximumHoldingMinutes)
    if (portfolio.exitRequestedAt !== null || now >= Date.parse(holdDue))
      return yield* Result.fail(
        new JevContractError({ message: 'An exit request or elapsed holding limit forbids a hold' }),
      )
    const { bid, quote } = yield* verifiedPositionQuote({ ...evidence, symbol: position.symbol }, evidence.source)
    if (jevProtectiveStopCrossed(bid, entryPlan.levels) || (yield* jevProfitTargetCrossed(portfolio, bid)))
      return yield* Result.fail(new JevContractError({ message: 'An executable exit threshold forbids a hold' }))
    return {
      schemaVersion: 'bayn.jev-position-hold.v1' as const,
      entryDecisionHash: portfolio.entryDecisionHash,
      validUntil: new Date(
        Math.min(
          Date.parse(holdDue),
          jevBrokerEvidenceFreshUntilMs(portfolio.brokerState),
          Date.parse(quote.eventAt) + evidence.protocol.maximumQuoteAgeMs,
        ),
      ).toISOString(),
      evidence,
    }
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Position hold evidence does not reproduce', cause })),
  )

export const JevPositionHoldSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-position-hold.v1'),
  entryDecisionHash: Sha256Schema,
  validUntil: UtcInstantSchema,
  evidence: JevPositionHoldEvidenceSchema,
}).check(
  Schema.makeFilter(
    (hold) => {
      const reproduced = decideJevPositionHold(hold.evidence).pipe(Result.flatMap(canonicalHashV1Result))
      const supplied = canonicalHashV1Result(hold)
      return Result.isSuccess(reproduced) && Result.isSuccess(supplied) && reproduced.success === supplied.success
    },
    { expected: 'the exact position hold reproduced from retained causal position and quote evidence' },
  ),
)
export type JevPositionHold = typeof JevPositionHoldSchema.Type
