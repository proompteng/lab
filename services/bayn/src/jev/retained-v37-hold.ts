import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { deriveJevPositionHoldMaterial, JevPositionHoldEvidenceSchema, JevPositionHoldSchema } from './hold'
import { JevPurpose } from './portfolio'
import { retainedJevProtocolV37ParameterHash, RetainedJevProtocolV37Schema } from './protocol'

const RetainedV37PositionHoldEvidenceSchema = Schema.Struct({
  ...JevPositionHoldEvidenceSchema.fields,
  // 0506c9d7 admitted one positive long position and no later protection-evidence marker.
  portfolio: JevPositionHoldEvidenceSchema.fields.portfolio.check(
    Schema.makeFilter(
      (portfolio) =>
        portfolio.purpose === JevPurpose.Manage &&
        !('protectionEvidenceVersion' in portfolio) &&
        portfolio.brokerState.positions
          .filter((position) => BigInt(position.quantityAtoms) !== 0n)
          .every((position) => BigInt(position.quantityAtoms) > 0n && BigInt(position.costBasisMicros) > 0n) &&
        Object.values(portfolio.exitPolicy.plans).every(
          (plan) =>
            plan.schemaVersion === 'bayn.jev-funded-exit-plan.v4' ||
            plan.schemaVersion === 'bayn.momentum-funded-exit-plan.v1',
        ),
      { expected: 'the original v37 long-only portfolio without later protection evidence fields' },
    ),
  ),
  protocol: RetainedJevProtocolV37Schema.check(
    Schema.makeFilter(
      (protocol) => {
        const hash = canonicalHashV1Result(protocol)
        return Result.isSuccess(hash) && hash.success === retainedJevProtocolV37ParameterHash
      },
      { expected: 'the original frozen v37 protocol identity' },
    ),
  ),
})

/** Archived operational source reads only; current hold admission retains JevPositionHoldSchema. */
export const RetainedV37JevPositionHoldSchema = Schema.Struct({
  ...JevPositionHoldSchema.fields,
  evidence: RetainedV37PositionHoldEvidenceSchema,
}).check(
  Schema.makeFilter(
    (hold) => {
      const reproduced = deriveJevPositionHoldMaterial(hold.evidence).pipe(Result.flatMap(canonicalHashV1Result))
      const supplied = canonicalHashV1Result(hold)
      return Result.isSuccess(reproduced) && Result.isSuccess(supplied) && reproduced.success === supplied.success
    },
    { expected: 'the original v37 position hold reproduced from its retained position and executable quote' },
  ),
)
