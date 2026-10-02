import * as Schema from 'effect/Schema'

import { FILE_PAGE_LIMIT } from './diagnostic-files'

const Count = Schema.Number.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER))
const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
const FileInput = {
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)).annotations({
    description: 'Existing regular file inside the workspace or owned repo session. Symlink escapes are rejected.',
  }),
  sessionId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
}
const FileIdentity = {
  path: Schema.String,
  version: Digest,
  sizeBytes: Count,
  modifiedAt: Schema.String,
}
const CompleteFileIdentity = { ...FileIdentity, sha256: Digest, completeFile: Schema.Literal(true) }

export const FileRangeInputSchema = Schema.Struct({
  ...FileInput,
  offset: Schema.optional(Count),
  maxBytes: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, FILE_PAGE_LIMIT))),
  expectedVersion: Schema.optional(
    Digest.annotations({ description: 'Version from the preceding page. Changed files fail closed.' }),
  ),
})
export const FileRangeOutputSchema = Schema.Struct({
  ...FileIdentity,
  offset: Count,
  nextOffset: Count,
  endOfFile: Schema.Boolean,
  content: Schema.String,
})
export const EvidenceInputSchema = Schema.Struct({
  ...FileInput,
  format: Schema.Literal('json', 'ndjson', 'json-stream'),
  expectedSha256: Schema.optional(Digest),
})
export const EvidenceOutputSchema = Schema.Struct({
  ...CompleteFileIdentity,
  format: Schema.Literal('json', 'ndjson', 'json-stream'),
  documentCount: Count,
  objectDocuments: Count,
  arrayDocuments: Count,
  scalarDocuments: Count,
  topLevelArrayElements: Count,
  blankLines: Count,
})
const DurationSummary = Schema.Struct({
  count: Count,
  minimum: Schema.NullOr(Schema.Number),
  maximum: Schema.NullOr(Schema.Number),
  p50: Schema.NullOr(Schema.Number),
  p95: Schema.NullOr(Schema.Number),
  total: Schema.NullOr(Schema.Number),
})
const Timestamp = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/))
export const PostgresLogInputSchema = Schema.Struct({
  ...FileInput,
  startAt: Timestamp.annotations({
    description: 'Inclusive UTC event-time bound. The interval cannot exceed 24 hours.',
  }),
  endAt: Timestamp.annotations({ description: 'Exclusive UTC event-time bound.' }),
  expectedSha256: Schema.optional(Digest),
})
export const PostgresLogOutputSchema = Schema.Struct({
  ...CompleteFileIdentity,
  startAt: Timestamp,
  endAt: Timestamp,
  sessionCoverage: Schema.Literal('not_proven'),
  firstObservedAt: Schema.NullOr(Timestamp),
  lastObservedAt: Schema.NullOr(Timestamp),
  firstInRangeAt: Schema.NullOr(Timestamp),
  lastInRangeAt: Schema.NullOr(Timestamp),
  linesRead: Count,
  inRangeRecords: Count,
  outOfRangeRecords: Count,
  malformedLines: Count,
  unrecognizedRecords: Count,
  recordsWithoutTimestamp: Count,
  invalidNumericRecords: Count,
  blankLines: Count,
  replicationTimeouts: Count,
  slowCommitsOverOneSecond: Count,
  severities: Schema.Struct({
    DEBUG: Count,
    INFO: Count,
    LOG: Count,
    NOTICE: Count,
    WARNING: Count,
    ERROR: Count,
    FATAL: Count,
    PANIC: Count,
    UNKNOWN: Count,
  }),
  quantileMethod: Schema.Literal('nearest_rank'),
  statementDurationMs: DurationSummary,
  parseDurationMs: DurationSummary,
  bindDurationMs: DurationSummary,
  unattributedDurationMs: DurationSummary,
  commitDurationMs: DurationSummary,
  checkpointSyncMs: DurationSummary,
  restartpointSyncMs: DurationSummary,
})
