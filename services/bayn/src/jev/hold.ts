import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevContractError } from './contract'
import {
  JevPositionEvidenceSchema,
  type JevExitEvidenceMaterial,
  jevBrokerEvidenceFreshUntilMs,
  jevMaximumHoldDueAt,
  jevProtectiveStopCrossed,
  validateJevPositionEvidence,
  verifiedPositionQuote,
} from './exit'
import { JevObservationSchema } from './observation-contract'
import { jevProfitTargetCrossed } from './profit-target'
import { isShortExitPlan } from '../strategy/funded-exit-plan'

export const JevPositionHoldEvidenceSchema = Schema.Struct({
  ...JevPositionEvidenceSchema.fields,
  authorityGenerationHash: Sha256Schema,
  source: Schema.Struct({
    manifest: JevObservationSchema.fields.manifest,
    rows: JevObservationSchema.fields.rows,
  }),
})

type JevPositionHoldEvidenceMaterial = Omit<typeof JevPositionHoldEvidenceSchema.Type, 'protocol'> &
  Pick<JevExitEvidenceMaterial, 'protocol'>

/** Pure reproduction preserves the decoded policy and evidence without supplying current defaults. */
export const deriveJevPositionHoldMaterial = <Evidence extends JevPositionHoldEvidenceMaterial>(evidence: Evidence) =>
  Result.gen(function* () {
    const { portfolio, position, firstFill, entryPlan, now } = yield* validateJevPositionEvidence(evidence)
    const holdDue = jevMaximumHoldDueAt(firstFill.occurredAt, entryPlan.levels.maximumHoldingMinutes)
    if (portfolio.exitRequestedAt !== null || now >= Date.parse(holdDue))
      return yield* Result.fail(
        new JevContractError({ message: 'An exit request or elapsed holding limit forbids a hold' }),
      )
    const short = isShortExitPlan(entryPlan)
    const { bid, ask, quote } = yield* verifiedPositionQuote(
      { ...evidence, symbol: position.symbol, ...(short ? { positionSide: 'SHORT' as const } : {}) },
      evidence.source,
    )
    const exitPrice = short ? ask : bid
    if (
      jevProtectiveStopCrossed(exitPrice, entryPlan.levels) ||
      (yield* jevProfitTargetCrossed(portfolio, exitPrice, position.symbol))
    )
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
  })

/** Reproduce a strategy hold from the same owned position and executable quote required for an exit. */
export const decideJevPositionHold = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevPositionHoldEvidenceSchema,
    strictParseOptions,
  )(input).pipe(
    Result.flatMap(deriveJevPositionHoldMaterial),
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
