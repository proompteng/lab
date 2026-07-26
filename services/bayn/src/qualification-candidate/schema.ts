import { isIP } from 'node:net'

import { Schema } from 'effect'

import { Sha256Schema, TrimmedNonEmptyStringSchema, strictParseOptions } from '../schemas'

const dnsLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

export const CandidateReplicaUrlsSchema = Schema.Array(Schema.URLFromString).check(
  Schema.makeFilter((urls: readonly URL[]) => urls.length === 2, {
    expected: 'exactly two direct ClickHouse replica URLs',
  }),
)

export const CandidatePostgresTlsServerNameSchema = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      value.length > 0 &&
      value.length <= 253 &&
      value === value.trim() &&
      isIP(value) === 0 &&
      value.split('.').every((label) => label.length <= 63 && dnsLabelPattern.test(label)),
    {
      expected: 'a non-empty DNS name without surrounding whitespace',
    },
  ),
)

const CandidateRowSchema = Schema.Struct({
  snapshot_id: Sha256Schema,
  calendar_version: TrimmedNonEmptyStringSchema,
})

const ReplicaIdentityRowSchema = Schema.Struct({
  replica: TrimmedNonEmptyStringSchema,
  principal: TrimmedNonEmptyStringSchema,
})

const ReadOnlyRowSchema = Schema.Struct({ read_only: Schema.Boolean })

const LockCountRowSchema = Schema.Struct({
  lock_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

export const decodeCandidateRows = Schema.decodeUnknownEffect(Schema.Tuple([CandidateRowSchema]), strictParseOptions)
export const decodeReplicaIdentityRows = Schema.decodeUnknownEffect(
  Schema.Tuple([ReplicaIdentityRowSchema]),
  strictParseOptions,
)
export const decodeReadOnlyRows = Schema.decodeUnknownEffect(Schema.Tuple([ReadOnlyRowSchema]), strictParseOptions)
export const decodeLockCountRows = Schema.decodeUnknownEffect(Schema.Tuple([LockCountRowSchema]), strictParseOptions)
