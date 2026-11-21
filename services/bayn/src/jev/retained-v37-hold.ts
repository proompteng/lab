import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { deriveJevPositionHoldMaterial, JevPositionHoldEvidenceSchema, JevPositionHoldSchema } from './hold'
import { retainedJevProtocolV37ParameterHash, RetainedJevProtocolV37Schema } from './protocol'

const RetainedV37PositionHoldEvidenceSchema = Schema.Struct({
  ...JevPositionHoldEvidenceSchema.fields,
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
