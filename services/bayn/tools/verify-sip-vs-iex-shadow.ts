import { NodeRuntime, NodeServices } from '@effect/platform-node'
import {
  Cause,
  Clock,
  Config,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Redacted,
  Schema,
  SchemaIssue,
  Stdio,
  Stream,
} from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from 'effect/http'
import { parseArgs } from 'node:util'

import { MarketCalendarResponseSchema } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { alpacaLiveBaseUrl, alpacaSandboxBaseUrl } from '../src/broker/connection'
import { intradayInstantNanos } from '../src/market-data/intraday/time'
import { sipTopics } from '../src/market-data/sip/provenance'
import { IsoDateSchema, type IsoDate, strictParseOptions } from '../src/schemas'
import {
  ReportFormat,
  ReportFormatSchema,
  ShadowParityError,
  ShadowSessionSchema,
  compareShadowSnapshot,
  decodeBarLine,
  decodeQuoteLine,
  decodeShadowSnapshot,
  iexTopics,
  makeShadowComparison,
  maxBars,
  maxQuotes,
  renderShadowReport,
} from './sip-vs-iex-shadow-core'

const usage =
  'Usage: bun services/bayn/tools/verify-sip-vs-iex-shadow.ts --session YYYY-MM-DD [--format markdown|json] [--fixture PATH]'
const failure = (message: string, cause?: string) =>
  new ShadowParityError(cause === undefined ? { message } : { message, cause })

const unexpectedProperty = 'Unexpected property'
const formatSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => (issue._tag === 'UnexpectedKey' ? unexpectedProperty : SchemaIssue.defaultLeafHook(issue)),
})
const schemaFailure = (context: string, error: Schema.SchemaError) => {
  // These decoders disable input reporting and use static schema messages, but an excess key is itself input.
  const issues = formatSchemaIssues(error.issue).issues.map(({ path: segments = [], message: reason }) => {
    const fields = reason === unexpectedProperty ? segments.slice(0, -1) : segments
    let path = '$'
    for (const key of fields) {
      if (typeof key === 'number') path += `[${key}]`
      else if (typeof key === 'string') path += `.${key}`
      else path += '[?]'
    }
    return { path, reason }
  })
  return new ShadowParityError({
    message: `${context}: ${issues.map(({ path, reason }) => `${path}: ${reason}`).join('; ')}`,
    cause: { _tag: 'ShadowSchemaValidationError', issues },
  })
}

const ArgsSchema = Schema.Struct({
  session: IsoDateSchema,
  format: Schema.optionalKey(ReportFormatSchema),
  fixture: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
})
const decodeArgs = Schema.decodeUnknownEffect(ArgsSchema, strictParseOptions)
const decodeSession = Schema.decodeUnknownEffect(ShadowSessionSchema, strictParseOptions)

const readOnlyHttp = (request: HttpClientRequest.HttpClientRequest, label: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* HttpClient.withScope(http)
      .execute(request)
      .pipe(Effect.mapError((cause) => failure(`${label}: HTTP transport failed`, cause.reason._tag)))
    if (response.status !== 200) return yield* failure(`${label}: HTTP ${response.status}`)
    if (response.headers['x-clickhouse-exception-code'] !== undefined)
      return yield* failure(`${label}: ClickHouse exception`)
    return response
  })

const readSession = (date: IsoDate) =>
  Effect.gen(function* () {
    const origin = yield* Config.String('BAYN_ALPACA_BASE_URL').pipe(Config.withDefault(alpacaSandboxBaseUrl))
    if (origin !== alpacaSandboxBaseUrl && origin !== alpacaLiveBaseUrl)
      return yield* failure('BAYN_ALPACA_BASE_URL must be an approved Alpaca API origin')
    const key = yield* Config.Redacted('BAYN_ALPACA_KEY_ID')
    const secret = yield* Config.Redacted('BAYN_ALPACA_SECRET_KEY')
    const request = HttpClientRequest.get(`${origin}/v2/calendar`).pipe(
      HttpClientRequest.setUrlParams({ start: date, end: date, date_type: 'TRADING' }),
      HttpClientRequest.setHeaders({
        'APCA-API-KEY-ID': Redacted.value(key),
        'APCA-API-SECRET-KEY': Redacted.value(secret),
      }),
    )
    const response = yield* readOnlyHttp(request, 'Alpaca calendar')
    const json = yield* response.json.pipe(Effect.mapError(() => failure('Alpaca calendar: invalid JSON response')))
    const raw = yield* Schema.decodeUnknownEffect(MarketCalendarResponseSchema)(json).pipe(
      Effect.mapError(() => failure('Alpaca calendar: invalid calendar rows')),
    )
    const calendar = yield* Effect.fromResult(normalizeMarketCalendarResult(raw, { start: date, end: date }))
    const day = calendar.providerSessions[0]
    if (day === undefined) return yield* failure(`No Alpaca regular session for ${date}`)
    const session = yield* decodeSession({ date, openAt: day.regularOpenAt, closeAt: day.regularCloseAt })
    const now = yield* Clock.currentTimeMillis
    if (intradayInstantNanos(session.closeAt) > BigInt(now) * 1_000_000n)
      return yield* failure(`Regular session ${date} has not closed`)
    return session
  }).pipe(
    Effect.scoped,
    Effect.timeout('15 seconds'),
    Effect.catchTag('TimeoutError', () => failure('Alpaca calendar read exceeded 15 seconds')),
  )

// Use HTTP GET and fixed parameterized SELECTs. The SQL client's interruption path sends KILL QUERY;
// this verifier never sends command-mode SQL, including on cancellation.
const identityColumns = `provider, feed, delay_class, source_topic, universe_id, universe_symbol_hash, symbol, schema_version`
const utcColumn = (column: string) => `concat(replaceOne(toString(${column}), ' ', 'T'), 'Z')`
const interval = (column: string, precision: 3 | 9) => `
  ${column} >= parseDateTime64BestEffort({open:String}, ${precision}, 'UTC')
  AND ${column} < parseDateTime64BestEffort({close:String}, ${precision}, 'UTC')`
const topicFilter = 'source_topic IN ({iexTopic:String}, {sipTopic:String})'
const queries = {
  bars: `
    SELECT ${identityColumns},
      ${utcColumn('coalesce(event_ts_exact, event_ts)')} AS event_at,
      ${utcColumn('coalesce(ingest_ts_exact, ingest_ts)')} AS ingested_at,
      is_final, source_partition, toString(source_offset) AS source_offset, close
    FROM signal.intraday_bars_1m_v2 FINAL
    WHERE ${topicFilter} AND ${interval('event_ts', 3)}
      AND ${interval('coalesce(event_ts_exact, event_ts)', 9)}
    LIMIT ${maxBars + 1}
    FORMAT JSONEachRow`,
  quotes: `
    SELECT ${identityColumns},
      ${utcColumn('event_ts')} AS event_at, ${utcColumn('ingest_ts')} AS ingested_at,
      bid_price, ask_price, bid_size, ask_size
    FROM signal.intraday_quotes_v1 FINAL
    WHERE ${topicFilter} AND ${interval('event_ts', 9)}
    LIMIT ${maxQuotes + 1}
    FORMAT JSONEachRow`,
} as const

const readArchive = (session: typeof ShadowSessionSchema.Type) =>
  Effect.gen(function* () {
    const endpoint = yield* Config.Redacted('BAYN_CLICKHOUSE_URL')
    const username = yield* Config.Redacted('BAYN_CLICKHOUSE_USERNAME')
    const password = yield* Config.Redacted('BAYN_CLICKHOUSE_PASSWORD')
    const url = URL.parse(Redacted.value(endpoint))
    if (
      url === null ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    )
      return yield* failure('BAYN_CLICKHOUSE_URL must be an HTTP(S) endpoint without user info, query or fragment')
    const comparison = makeShadowComparison(session)
    const query = (kind: keyof typeof queries) => {
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setUrlParams({
          query: queries[kind],
          param_open: session.openAt,
          param_close: session.closeAt,
          param_iexTopic: iexTopics[kind],
          param_sipTopic: sipTopics[kind],
        }),
        HttpClientRequest.setHeaders({
          'X-ClickHouse-User': Redacted.value(username),
          'X-ClickHouse-Key': Redacted.value(password),
        }),
      )
      const limit = kind === 'bars' ? maxBars : maxQuotes
      let count = 0
      return Effect.gen(function* () {
        const response = yield* readOnlyHttp(request, `ClickHouse ${kind}`)
        yield* response.stream.pipe(
          Stream.mapError((cause) => failure(`ClickHouse ${kind}: HTTP body read failed`, cause._tag)),
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEachArray((lines) =>
            Effect.gen(function* () {
              for (const line of lines) {
                count++
                if (count > limit) return yield* failure(`ClickHouse ${kind}: exceeded ${limit} rows`)
                if (kind === 'bars') {
                  const row = yield* Effect.fromResult(decodeBarLine(line)).pipe(
                    Effect.mapError((error) => schemaFailure(`ClickHouse bars: invalid row at line ${count}`, error)),
                  )
                  comparison.addBar(row)
                } else {
                  const row = yield* Effect.fromResult(decodeQuoteLine(line)).pipe(
                    Effect.mapError((error) => schemaFailure(`ClickHouse quotes: invalid row at line ${count}`, error)),
                  )
                  comparison.addQuote(row)
                }
              }
            }),
          ),
        )
      }).pipe(
        Effect.scoped,
        Effect.timeout('20 minutes'),
        Effect.catchTag('TimeoutError', () => failure(`ClickHouse ${kind} read exceeded 20 minutes`)),
      )
    }
    yield* query('bars')
    yield* query('quotes')
    return yield* Effect.fromResult(comparison.finish())
  })

const maxFixtureBytes = 64 * 1024 * 1024
const parseFixture = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown), { reportInput: false })
const readFixture = (path: string, sessionDate: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const stat = yield* fs.stat(path)
    if (stat.type !== 'File' || stat.size > BigInt(maxFixtureBytes))
      return yield* failure('Fixture must be a regular file no larger than 64 MiB')
    const text = yield* fs.readFileString(path)
    const json = yield* Effect.fromResult(parseFixture(text)).pipe(
      Effect.mapError((error) => schemaFailure('Fixture is not valid JSON', error)),
    )
    const snapshot = yield* Effect.fromResult(decodeShadowSnapshot(json)).pipe(
      Effect.mapError((error) => schemaFailure('Fixture does not match the session, bar and quote schemas', error)),
    )
    if (snapshot.session.date !== sessionDate) return yield* failure('Fixture session does not match --session')
    return yield* Effect.fromResult(compareShadowSnapshot(snapshot))
  })

export const runShadowVerifier = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const print = (text: string) => Stream.run(Stream.make(`${text}\n`), stdio.stdout())
    if (argv.length === 1 && argv[0] === '--help') return yield* print(usage)
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...argv],
          options: {
            session: { type: 'string', multiple: true },
            format: { type: 'string', multiple: true },
            fixture: { type: 'string', multiple: true },
          },
        }),
      catch: () => failure(usage),
    })
    const { session, format, fixture } = parsed.values
    if (session?.length !== 1 || (format?.length ?? 0) > 1 || (fixture?.length ?? 0) > 1) return yield* failure(usage)
    const args = yield* decodeArgs({
      session: session[0],
      ...(format === undefined ? {} : { format: format[0] }),
      ...(fixture === undefined ? {} : { fixture: fixture[0] }),
    }).pipe(Effect.mapError(() => failure(usage)))
    const report =
      args.fixture === undefined
        ? yield* Effect.flatMap(readSession(args.session), readArchive)
        : yield* readFixture(args.fixture, args.session)
    yield* print(renderShadowReport(report, args.format ?? ReportFormat.Markdown))
    if (!report.gate.pass) return yield* failure('SIP shadow promotion gate failed; see scorecard on stdout')
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
    Effect.provideService(Headers.CurrentRedactedNames, [
      'authorization',
      'cookie',
      'set-cookie',
      'apca-api-key-id',
      'apca-api-secret-key',
      'x-clickhouse-user',
      'x-clickhouse-key',
    ]),
  )

if (import.meta.main)
  NodeRuntime.runMain(
    runShadowVerifier(process.argv.slice(2)).pipe(
      // RunMain's default failure log sits outside this layer and would corrupt JSON on stdout.
      Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause))),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition owns platform resources
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          Logger.layer([Logger.withConsoleError(Logger.formatJson)]),
        ),
      ),
    ),
    { disableErrorReporting: true },
  )
