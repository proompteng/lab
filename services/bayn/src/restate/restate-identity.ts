import { Schema } from 'effect'
import { strictParseOptions } from '../schemas'

const RestateRequestIdentityKeySchema = Schema.Trim.check(Schema.isPattern(/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/))
const RestateRequestIdentityKeysSchema = Schema.Array(RestateRequestIdentityKeySchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
  Schema.isUnique(),
)

export const decodeRestateRequestIdentityKeys = (candidate: string) =>
  Schema.decodeUnknownResult(RestateRequestIdentityKeysSchema, strictParseOptions)(candidate.split(','))
