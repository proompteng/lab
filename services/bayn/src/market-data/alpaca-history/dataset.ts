import { Data, Effect, FileSystem, Result, Schema } from 'effect'
import { decodeMarketCalendar } from '../../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import { canonicalHashV1Result, sha256 } from '../../hash'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  SymbolSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
  strictParseOptions,
} from '../../schemas'
import { StoredHistoricalCaptureSchema } from './model'
import { normalizedRowsHashResult } from './normalization'

export const HistoricalDatasetRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-backfill.v1'),
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  executionSessions: Schema.Array(IsoDateSchema).check(Schema.isUnique()),
}).check(
  Schema.makeFilter(
    (input) =>
      input.startDate <= input.endDate &&
      input.executionSessions.every((date) => date >= input.startDate && date <= input.endDate),
    { expected: 'ordered dates containing every execution session' },
  ),
)

export class HistoricalDatasetFailure extends Data.TaggedError('HistoricalDatasetFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const HistoricalKindSchema = Schema.Literals(['bars', 'quotes', 'trades'])
export const HistoricalCoverageSchema = Schema.Array(
  Schema.Struct({
    symbol: SymbolSchema,
    sessionDate: IsoDateSchema,
    kind: HistoricalKindSchema,
    records: NonNegativeIntegerSchema,
    firstEventAt: Schema.NullOr(UtcOrderTimestampSchema),
    lastEventAt: Schema.NullOr(UtcOrderTimestampSchema),
    missingMinutes: Schema.Array(UtcInstantSchema),
    coverage: Schema.Literals(['EMPTY', 'GAPPED', 'COMPLETE_MINUTE_GRID', 'RETURNED_EVENT_STREAM']),
    paginationComplete: Schema.Literal(true),
  }),
)
const HistoricalChunkSchema = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^chunks\/[a-f0-9]{64}\.json$/)),
  sha256: Sha256Schema,
  queryHash: Sha256Schema,
  normalizedHash: Sha256Schema,
  kind: HistoricalKindSchema,
  sessionDate: IsoDateSchema,
  rowCount: NonNegativeIntegerSchema,
  retrievedAt: UtcInstantSchema,
})
export type HistoricalChunk = typeof HistoricalChunkSchema.Type
export const HistoricalDatasetManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-history-dataset.v1'),
  request: HistoricalDatasetRequestSchema,
  provider: Schema.Literal('alpaca'),
  transport: Schema.Literal('historical-rest'),
  feed: Schema.Literal('iex'),
  adjustment: Schema.Literal('raw'),
  originalStreamAvailability: Schema.Literal('NOT_OBSERVED'),
  revisionKnowledge: Schema.Literal('REST_AS_OF_RETRIEVAL'),
  calendar: Schema.Struct({ path: Schema.Literal('calendar.json'), sha256: Sha256Schema }),
  coverage: Schema.Struct({
    path: Schema.Literal('coverage.json'),
    sha256: Sha256Schema,
    rows: NonNegativeIntegerSchema,
  }),
  chunks: Schema.Array(HistoricalChunkSchema).check(Schema.isMinLength(1)),
  recordCount: NonNegativeIntegerSchema,
  datasetId: Sha256Schema,
})
export type HistoricalDatasetManifest = typeof HistoricalDatasetManifestSchema.Type

export const decodeHistoricalManifest = (text: string, expectedId: string) =>
  Result.gen(function* () {
    yield* Schema.decodeUnknownResult(Sha256Schema)(expectedId)
    const manifest = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(HistoricalDatasetManifestSchema),
      strictParseOptions,
    )(text)
    const { datasetId, ...material } = manifest
    if (datasetId !== expectedId || datasetId !== (yield* canonicalHashV1Result(material)))
      return yield* Result.fail(
        new HistoricalDatasetFailure({ message: 'Historical dataset differs from the pinned identity' }),
      )
    if (
      new Set(manifest.chunks.map((chunk) => chunk.queryHash)).size !== manifest.chunks.length ||
      manifest.chunks.some((chunk) => chunk.path !== `chunks/${chunk.queryHash}.json`) ||
      manifest.chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0) !== manifest.recordCount
    )
      return yield* Result.fail(
        new HistoricalDatasetFailure({
          message: 'Historical manifest repeats a query or disagrees with its record count',
        }),
      )
    return manifest
  })

export const readHistoricalDataset = (directory: string, expectedId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifestText = yield* fs.readFileString(`${directory}/dataset.json`)
    const manifest = yield* Effect.fromResult(decodeHistoricalManifest(manifestText, expectedId))
    const calendarText = yield* fs.readFileString(`${directory}/calendar.json`)
    const coverageText = yield* fs.readFileString(`${directory}/coverage.json`)
    if (sha256(calendarText) !== manifest.calendar.sha256 || sha256(coverageText) !== manifest.coverage.sha256)
      return yield* new HistoricalDatasetFailure({ message: 'Historical calendar or coverage checksum differs' })
    const calendar = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(calendarText).pipe(
      Effect.flatMap((input) => Effect.fromResult(decodeMarketCalendar(input))),
    )
    const coverage = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(HistoricalCoverageSchema),
      strictParseOptions,
    )(coverageText)
    const sessions = yield* Effect.forEach(calendar, (day) =>
      Effect.fromResult(normalizeMarketCalendarResult([day], { start: day.date, end: day.date })).pipe(
        Effect.flatMap((value) =>
          value.sessions[0] === undefined
            ? Effect.fail(new HistoricalDatasetFailure({ message: 'Historical calendar has no session' }))
            : Effect.succeed(value.sessions[0]),
        ),
      ),
    )
    if (
      coverage.length !== manifest.coverage.rows ||
      sessions.length === 0 ||
      new Set(sessions.map((day) => day.date)).size !== sessions.length ||
      sessions.some(
        (day, index) =>
          day.date < manifest.request.startDate ||
          day.date > manifest.request.endDate ||
          (index > 0 && day.date <= (sessions[index - 1]?.date ?? '')),
      )
    )
      return yield* new HistoricalDatasetFailure({
        message: 'Historical coverage or calendar does not match its manifest',
      })
    return { directory, manifest, manifestText, calendar, calendarText, coverage, coverageText, sessions }
  })
export type HistoricalDataset = Effect.Success<ReturnType<typeof readHistoricalDataset>>

export const readHistoricalChunk = (dataset: HistoricalDataset, chunk: HistoricalChunk) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`${dataset.directory}/${chunk.path}`)
    if (sha256(text) !== chunk.sha256)
      return yield* new HistoricalDatasetFailure({ message: `Historical chunk checksum differs: ${chunk.queryHash}` })
    const capture = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(StoredHistoricalCaptureSchema),
      strictParseOptions,
    )(text)
    const provenance = capture.provenance
    if (
      capture.kind !== chunk.kind ||
      capture.rows.length !== chunk.rowCount ||
      provenance.queryHash !== chunk.queryHash ||
      provenance.sessionDate !== chunk.sessionDate ||
      provenance.normalizedHash !== chunk.normalizedHash ||
      provenance.retrievedAt !== chunk.retrievedAt ||
      provenance.endpointPath !== `/v2/stocks/${capture.kind}` ||
      capture.provenanceHash !== (yield* Effect.fromResult(canonicalHashV1Result(provenance))) ||
      chunk.normalizedHash !== (yield* Effect.fromResult(normalizedRowsHashResult(capture.rows)))
    )
      return yield* new HistoricalDatasetFailure({ message: `Historical chunk provenance differs: ${chunk.queryHash}` })
    const session = dataset.sessions.find((day) => day.date === chunk.sessionDate)
    if (
      session === undefined ||
      capture.rows.some(
        (row) =>
          !dataset.manifest.request.symbols.includes(row.symbol) ||
          !provenance.requestedSymbols.includes(row.symbol) ||
          Date.parse(row.eventAt) < Date.parse(session.openAt) ||
          Date.parse(row.eventAt) > Date.parse(session.closeAt),
      )
    )
      return yield* new HistoricalDatasetFailure({
        message: `Historical chunk leaves its declared universe or session: ${chunk.queryHash}`,
      })
    return capture
  })
