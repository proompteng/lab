import { Clock, Duration, Effect, FileSystem, Option, Redacted, Ref, Result, Schema, Semaphore } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'

import { canonicalHashV1Result, canonicalJsonV1Result, renderCanonicalJsonFailure, sha256 } from '../../../hash'
import { utcInstantFromEpochMillis } from '../../../time'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../../schemas'
import {
  alpacaHistoricalDataOrigin,
  alpacaHistoricalFeed,
  alpacaHistoricalMaximumPages,
  alpacaHistoricalMaximumRetryAttempts,
  alpacaHistoricalMaximumRetryDelayMs,
  alpacaHistoricalPageLimit,
  alpacaHistoricalRateLimitPerMinute,
  alpacaHistoricalRequestTimeoutMs,
  decodeAlpacaHistoricalQuery,
  AlpacaHistoricalKind,
  VendorHistoricalFailure,
  type AlpacaHistoricalClient,
  type AlpacaHistoricalClientOptions,
  type AlpacaHistoricalCredentials,
  type AlpacaHistoricalQuery,
  type VendorHistoricalCapture,
  type VendorHistoricalBar,
  type VendorHistoricalQuote,
  type VendorHistoricalTrade,
  type VendorHistoricalPageReceipt,
  type VendorHistoricalProvenance,
  type VendorHistoricalQueryIdentity,
  type VendorHistoricalRow,
} from './model'
import {
  historicalRowKey,
  normalizeAlpacaHistoricalPage,
  normalizedRowsHashResult,
  type NormalizedHistoricalPage,
} from './normalization'

const cacheSchemaVersion = 'bayn.vendor-historical-cache.v1' as const
const queryIdentitySchemaVersion = 'bayn.vendor-historical-query.v1' as const
const pageReceiptSchemaVersion = 'bayn.vendor-historical-page-receipt.v2' as const
const regularSession = 'regular' as const
const timeBasis = 'event-time-only' as const
const minimumRetryDelayMs = 250

const QueryIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal(queryIdentitySchemaVersion),
  kind: Schema.Enum(AlpacaHistoricalKind),
  endpointPath: StrictNonEmptyStringSchema,
  symbols: Schema.Array(SymbolSchema),
  start: UtcInstantSchema,
  end: UtcInstantSchema,
  asof: IsoDateSchema,
  feed: Schema.Literal(alpacaHistoricalFeed),
  sort: Schema.Literal('asc'),
  limit: Schema.Literal(alpacaHistoricalPageLimit),
  timeframe: Schema.optionalKey(Schema.Literal('1Min')),
  adjustment: Schema.optionalKey(Schema.Literal('raw')),
})

const QueryCacheReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(cacheSchemaVersion),
  queryHash: Sha256Schema,
  identity: QueryIdentitySchema,
})

const PageCacheReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(pageReceiptSchemaVersion),
  queryHash: Sha256Schema,
  kind: Schema.Enum(AlpacaHistoricalKind),
  pageIndex: NonNegativeIntegerSchema,
  requestPageToken: Schema.NullOr(StrictNonEmptyStringSchema),
  status: Schema.Literal(200),
  retrievedAt: UtcInstantSchema,
  rawTextHash: Sha256Schema,
  normalizedHash: Sha256Schema,
  rowCount: NonNegativeIntegerSchema,
  nextPageToken: Schema.NullOr(StrictNonEmptyStringSchema),
  bodyPath: StrictNonEmptyStringSchema,
  receiptPath: StrictNonEmptyStringSchema,
})

type PageCacheReceipt = typeof PageCacheReceiptSchema.Type

interface CachedPage {
  readonly normalized: NormalizedHistoricalPage
  readonly receipt: PageCacheReceipt
}

interface ClientOptions {
  readonly maximumAttempts: number
  readonly requestTimeoutMs: number
  readonly maximumRetryDelayMs: number
  readonly maximumPages: number
}

const failure = (
  reason: ConstructorParameters<typeof VendorHistoricalFailure>[0]['reason'],
  message: string,
  retryable: boolean,
  options: {
    readonly status?: number
    readonly pageIndex?: number
    readonly cause?: unknown
  } = {},
): VendorHistoricalFailure =>
  new VendorHistoricalFailure({
    reason,
    message,
    retryable,
    ...(options.status === undefined ? undefined : { status: options.status }),
    ...(options.pageIndex === undefined ? undefined : { pageIndex: options.pageIndex }),
    ...(options.cause === undefined ? undefined : { cause: options.cause }),
  })

const failureOptions = (
  pageIndex: number | undefined,
  cause?: unknown,
): { readonly pageIndex?: number; readonly cause?: unknown } => ({
  ...(pageIndex === undefined ? {} : { pageIndex }),
  ...(cause === undefined ? {} : { cause }),
})

const endpointPath = (kind: AlpacaHistoricalKind): `/v2/stocks/${AlpacaHistoricalKind}` =>
  `/v2/stocks/${kind}` as `/v2/stocks/${AlpacaHistoricalKind}`

const queryIdentity = (query: AlpacaHistoricalQuery): VendorHistoricalQueryIdentity => {
  const base = {
    schemaVersion: queryIdentitySchemaVersion,
    kind: query.kind,
    endpointPath: endpointPath(query.kind),
    symbols: query.symbols,
    start: query.startAt,
    end: query.endAt,
    asof: query.sessionDate,
    feed: alpacaHistoricalFeed,
    sort: 'asc' as const,
    limit: alpacaHistoricalPageLimit,
  }
  return query.kind === 'bars' ? { ...base, timeframe: '1Min', adjustment: 'raw' } : base
}

const canonicalText = (
  value: unknown,
  operation: string,
  pageIndex?: number,
): Effect.Effect<string, VendorHistoricalFailure> => {
  const encoded = canonicalJsonV1Result(value)
  return Result.isFailure(encoded)
    ? Effect.fail(
        failure(
          'hash',
          `${operation} cannot be canonically serialized: ${renderCanonicalJsonFailure(encoded.failure)}`,
          false,
          failureOptions(pageIndex, encoded.failure),
        ),
      )
    : Effect.succeed(encoded.success)
}

const canonicalHash = (
  value: unknown,
  operation: string,
  pageIndex?: number,
): Effect.Effect<string, VendorHistoricalFailure> => {
  const hashed = canonicalHashV1Result(value)
  return Result.isFailure(hashed)
    ? Effect.fail(
        failure(
          'hash',
          `${operation} cannot be canonically hashed: ${renderCanonicalJsonFailure(hashed.failure)}`,
          false,
          failureOptions(pageIndex, hashed.failure),
        ),
      )
    : Effect.succeed(hashed.success)
}

const parseJson = (
  raw: string,
  operation: string,
  pageIndex?: number,
): Result.Result<unknown, VendorHistoricalFailure> => {
  const parsed = Result.try({ try: () => JSON.parse(raw) as unknown, catch: (cause) => cause })
  return Result.isFailure(parsed)
    ? Result.fail(
        failure('decode', `${operation} body is not valid JSON`, false, failureOptions(pageIndex, parsed.failure)),
      )
    : Result.succeed(parsed.success)
}

const retryAfterMillis = (header: string | undefined, now: number): number | undefined => {
  if (header === undefined || header.trim() === '') return undefined
  const value = header.trim()
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1_000)) : undefined
  }
  const dateMillis = Date.parse(value)
  return Number.isFinite(dateMillis) ? Math.max(0, dateMillis - now) : undefined
}

const makeHistoricalUrl = (query: AlpacaHistoricalQuery, pageToken: string | null): URL => {
  const url = new URL(endpointPath(query.kind), alpacaHistoricalDataOrigin)
  url.searchParams.set('symbols', query.symbols.join(','))
  url.searchParams.set('start', query.startAt)
  url.searchParams.set('end', query.endAt)
  url.searchParams.set('asof', query.sessionDate)
  url.searchParams.set('feed', alpacaHistoricalFeed)
  url.searchParams.set('sort', 'asc')
  url.searchParams.set('limit', String(alpacaHistoricalPageLimit))
  if (query.kind === 'bars') {
    url.searchParams.set('timeframe', '1Min')
    url.searchParams.set('adjustment', 'raw')
  }
  if (pageToken !== null) url.searchParams.set('page_token', pageToken)
  return url
}

const validateDataOrigin = (url: URL): Result.Result<URL, VendorHistoricalFailure> =>
  url.protocol === 'https:' && url.hostname === 'data.alpaca.markets' && url.port === ''
    ? Result.succeed(url)
    : Result.fail(failure('request', 'historical request target is outside the Alpaca data allowlist', false))

const pathForPage = (
  queryDirectory: string,
  pageIndex: number,
): { readonly bodyPath: string; readonly receiptPath: string } => {
  const name = pageIndex.toString().padStart(8, '0')
  return {
    bodyPath: `${queryDirectory}/page-${name}.body.json`,
    receiptPath: `${queryDirectory}/page-${name}.receipt.json`,
  }
}

const relativePagePath = (pageIndex: number, suffix: 'body.json' | 'receipt.json'): string =>
  `page-${pageIndex.toString().padStart(8, '0')}.${suffix}`

const validateOptions = (
  options: AlpacaHistoricalClientOptions,
): Result.Result<ClientOptions, VendorHistoricalFailure> => {
  const maximumAttempts = options.maximumAttempts ?? alpacaHistoricalMaximumRetryAttempts
  const requestTimeoutMs = options.requestTimeoutMs ?? alpacaHistoricalRequestTimeoutMs
  const maximumRetryDelayMs = options.maximumRetryDelayMs ?? alpacaHistoricalMaximumRetryDelayMs
  const maximumPages = options.maximumPages ?? alpacaHistoricalMaximumPages
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 5) {
    return Result.fail(
      failure('invalid-query', 'historical maximumAttempts must be an integer from 1 through 5', false),
    )
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    return Result.fail(failure('invalid-query', 'historical requestTimeoutMs must be a positive integer', false))
  }
  if (!Number.isSafeInteger(maximumRetryDelayMs) || maximumRetryDelayMs < minimumRetryDelayMs) {
    return Result.fail(failure('invalid-query', 'historical maximumRetryDelayMs is below the safety floor', false))
  }
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 1) {
    return Result.fail(failure('invalid-query', 'historical maximumPages must be a positive integer', false))
  }
  return Result.succeed({ maximumAttempts, requestTimeoutMs, maximumRetryDelayMs, maximumPages })
}

const validateDecodedQuery = (
  query: AlpacaHistoricalQuery,
): Result.Result<AlpacaHistoricalQuery, VendorHistoricalFailure> => {
  const decoded = decodeAlpacaHistoricalQuery(query)
  return Result.isFailure(decoded)
    ? Result.fail(
        failure('invalid-query', 'historical query violates the regular-session query contract', false, {
          cause: decoded.failure,
        }),
      )
    : Result.succeed(decoded.success)
}

const writeAtomic = (
  fs: FileSystem.FileSystem,
  path: string,
  value: string,
  pageIndex?: number,
): Effect.Effect<void, VendorHistoricalFailure> => {
  const temporaryPath = `${path}.tmp`
  return fs.writeFileString(temporaryPath, value).pipe(
    Effect.mapError(() =>
      failure('cache', `cannot write historical cache checkpoint ${path}`, false, failureOptions(pageIndex)),
    ),
    Effect.andThen(
      fs
        .rename(temporaryPath, path)
        .pipe(
          Effect.mapError(() =>
            failure('cache', `cannot commit historical cache checkpoint ${path}`, false, failureOptions(pageIndex)),
          ),
        ),
    ),
  )
}

const ensureQueryCache = (
  fs: FileSystem.FileSystem,
  query: AlpacaHistoricalQuery,
  queryHash: string,
  identity: VendorHistoricalQueryIdentity,
): Effect.Effect<string, VendorHistoricalFailure> =>
  Effect.gen(function* () {
    const queryDirectory = `${query.cacheDirectory}/${queryHash}`
    yield* fs
      .makeDirectory(queryDirectory, { recursive: true })
      .pipe(
        Effect.mapError(() => failure('cache', `cannot create historical cache directory ${queryDirectory}`, false)),
      )
    const queryPath = `${queryDirectory}/query.json`
    const exists = yield* fs
      .exists(queryPath)
      .pipe(Effect.mapError(() => failure('cache', `cannot inspect historical query receipt ${queryPath}`, false)))
    const expected = { schemaVersion: cacheSchemaVersion, queryHash, identity }
    if (!exists) {
      const serialized = yield* canonicalText(expected, 'historical query receipt')
      yield* writeAtomic(fs, queryPath, serialized)
      return queryDirectory
    }
    const raw = yield* fs
      .readFileString(queryPath)
      .pipe(Effect.mapError(() => failure('cache', `cannot read historical query receipt ${queryPath}`, false)))
    const parsed = parseJson(raw, 'historical query receipt')
    if (Result.isFailure(parsed)) return yield* parsed.failure
    const decoded = Schema.decodeUnknownResult(QueryCacheReceiptSchema, strictParseOptions)(parsed.success)
    if (Result.isFailure(decoded)) {
      return yield* failure('cache', `historical query receipt ${queryPath} is invalid`, false, {
        cause: decoded.failure,
      })
    }
    if (decoded.success.queryHash !== queryHash) {
      return yield* failure('cache', `historical query receipt ${queryPath} has a mismatched query hash`, false)
    }
    const identityHash = yield* canonicalHash(decoded.success.identity, 'cached historical query identity')
    if (identityHash !== queryHash) {
      return yield* failure('cache', `historical query receipt ${queryPath} does not match the requested query`, false)
    }
    return queryDirectory
  })

const readCachedPage = (
  fs: FileSystem.FileSystem,
  query: AlpacaHistoricalQuery,
  queryHash: string,
  queryDirectory: string,
  pageIndex: number,
  requestPageToken: string | null,
): Effect.Effect<Option.Option<CachedPage>, VendorHistoricalFailure> =>
  Effect.gen(function* () {
    const paths = pathForPage(queryDirectory, pageIndex)
    const [bodyExists, receiptExists] = yield* Effect.all([
      fs
        .exists(paths.bodyPath)
        .pipe(
          Effect.mapError(() =>
            failure('cache', `cannot inspect historical body ${paths.bodyPath}`, false, { pageIndex }),
          ),
        ),
      fs
        .exists(paths.receiptPath)
        .pipe(
          Effect.mapError(() =>
            failure('cache', `cannot inspect historical receipt ${paths.receiptPath}`, false, { pageIndex }),
          ),
        ),
    ])
    if (!bodyExists || !receiptExists) return Option.none<CachedPage>()
    const receiptRaw = yield* fs
      .readFileString(paths.receiptPath)
      .pipe(
        Effect.mapError(() =>
          failure('cache', `cannot read historical receipt ${paths.receiptPath}`, false, { pageIndex }),
        ),
      )
    const receiptJson = parseJson(receiptRaw, 'historical page receipt', pageIndex)
    if (Result.isFailure(receiptJson)) return yield* receiptJson.failure
    const receipt = Schema.decodeUnknownResult(PageCacheReceiptSchema, strictParseOptions)(receiptJson.success)
    if (Result.isFailure(receipt)) {
      return yield* failure('cache', `historical receipt ${paths.receiptPath} is invalid`, false, {
        pageIndex,
        cause: receipt.failure,
      })
    }
    if (
      receipt.success.queryHash !== queryHash ||
      receipt.success.pageIndex !== pageIndex ||
      receipt.success.kind !== query.kind ||
      receipt.success.requestPageToken !== requestPageToken ||
      receipt.success.bodyPath !== relativePagePath(pageIndex, 'body.json') ||
      receipt.success.receiptPath !== relativePagePath(pageIndex, 'receipt.json')
    ) {
      return yield* failure(
        'cache',
        `historical receipt ${paths.receiptPath} does not match the requested page`,
        false,
        {
          pageIndex,
        },
      )
    }
    const rawBody = yield* fs
      .readFileString(paths.bodyPath)
      .pipe(
        Effect.mapError(() => failure('cache', `cannot read historical body ${paths.bodyPath}`, false, { pageIndex })),
      )
    const rawHash = sha256(rawBody)
    if (rawHash !== receipt.success.rawTextHash) {
      return yield* failure('cache', `historical body ${paths.bodyPath} failed its checksum`, false, { pageIndex })
    }
    const bodyJson = parseJson(rawBody, 'historical page', pageIndex)
    if (Result.isFailure(bodyJson)) return yield* bodyJson.failure
    const normalized = normalizeAlpacaHistoricalPage(query.kind, bodyJson.success, query, pageIndex)
    if (Result.isFailure(normalized)) return yield* normalized.failure
    if (normalized.success.normalizedHash !== receipt.success.normalizedHash) {
      return yield* failure('cache', `historical body ${paths.bodyPath} failed its normalized checksum`, false, {
        pageIndex,
      })
    }
    if (normalized.success.rows.length !== receipt.success.rowCount) {
      return yield* failure('cache', `historical receipt ${paths.receiptPath} has a mismatched row count`, false, {
        pageIndex,
      })
    }
    const nextPageToken = normalized.success.nextPageToken ?? null
    if (nextPageToken !== receipt.success.nextPageToken) {
      return yield* failure('cache', `historical receipt ${paths.receiptPath} has a mismatched page token`, false, {
        pageIndex,
      })
    }
    return Option.some({ normalized: normalized.success, receipt: receipt.success })
  })

const reserveRateLimitSlot = (recentRequests: Ref.Ref<readonly number[]>): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const now = yield* Clock.currentTimeMillis
      const available = yield* Ref.modify(recentRequests, (timestamps) => {
        const fresh = timestamps.filter((timestamp) => now - timestamp < 60_000)
        return fresh.length < alpacaHistoricalRateLimitPerMinute ? [true, [...fresh, now]] : [false, fresh]
      })
      if (available) return
      const timestamps = yield* Ref.get(recentRequests)
      const first = timestamps[0]
      if (first === undefined) continue
      yield* Effect.sleep(Duration.millis(Math.max(1, first + 60_000 - now)))
    }
  })

const appendRows = (
  kind: AlpacaHistoricalKind,
  pageRows: readonly VendorHistoricalRow[],
  allRows: VendorHistoricalRow[],
  seen: Map<string, VendorHistoricalRow>,
  lastSymbolEvent: { value: string | undefined },
  pageIndex: number,
): Effect.Effect<void, VendorHistoricalFailure> => {
  for (const row of pageRows) {
    const symbolEvent = `${row.symbol}\u001f${row.eventAt}`
    if (lastSymbolEvent.value !== undefined && symbolEvent < lastSymbolEvent.value) {
      return Effect.fail(
        failure('pagination', `historical ${kind} pages are not ordered by symbol and event time`, false, {
          pageIndex,
        }),
      )
    }
    lastSymbolEvent.value = symbolEvent
    const key = historicalRowKey(kind, row)
    const previous = seen.get(key)
    if (previous !== undefined) {
      const message =
        kind === 'quotes'
          ? `historical quote record ${row.symbol} ${row.eventAt} is duplicated`
          : `historical ${kind} record ${row.symbol} ${row.eventAt} is duplicated or ambiguous`
      return Effect.fail(failure('normalization', message, false, { pageIndex }))
    }
    seen.set(key, row)
    allRows.push(row)
  }
  return Effect.void
}

const isHistoricalBar = (row: VendorHistoricalRow): row is VendorHistoricalBar => 'open' in row

const isHistoricalQuote = (row: VendorHistoricalRow): row is VendorHistoricalQuote => 'bidPrice' in row

const isHistoricalTrade = (row: VendorHistoricalRow): row is VendorHistoricalTrade => 'providerTradeId' in row

const toPublicReceipt = (receipt: PageCacheReceipt): VendorHistoricalPageReceipt => ({
  pageIndex: receipt.pageIndex,
  requestPageTokenHash: receipt.requestPageToken === null ? null : sha256(receipt.requestPageToken),
  status: 200,
  retrievedAt: receipt.retrievedAt,
  rawTextHash: receipt.rawTextHash,
  normalizedHash: receipt.normalizedHash,
  rowCount: receipt.rowCount,
  nextPageTokenHash: receipt.nextPageToken === null ? null : sha256(receipt.nextPageToken),
  nextPageTokenPresent: receipt.nextPageToken !== null,
  bodyPath: receipt.bodyPath,
  receiptPath: receipt.receiptPath,
})

export const makeAlpacaHistoricalClient = (
  httpClient: HttpClient.HttpClient,
  credentials: AlpacaHistoricalCredentials,
  options: AlpacaHistoricalClientOptions = {},
): Effect.Effect<AlpacaHistoricalClient, VendorHistoricalFailure> =>
  Effect.gen(function* () {
    const validatedOptions = validateOptions(options)
    if (Result.isFailure(validatedOptions)) return yield* validatedOptions.failure
    const config = validatedOptions.success
    const key = Redacted.value(credentials.key)
    const secret = Redacted.value(credentials.secret)
    if (key.length === 0 || secret.length === 0) {
      return yield* failure('invalid-credentials', 'historical Alpaca credentials are empty', false)
    }
    const requestSemaphore = yield* Semaphore.make(1)
    const recentRequests = yield* Ref.make<readonly number[]>([])

    const fetchPage = (
      query: AlpacaHistoricalQuery,
      pageIndex: number,
      requestPageToken: string | null,
    ): Effect.Effect<string, VendorHistoricalFailure> => {
      const retryDelayMillis = (attemptNumber: number): number =>
        Math.min(config.maximumRetryDelayMs, minimumRetryDelayMs * 2 ** (attemptNumber - 1))
      const urlResult = validateDataOrigin(makeHistoricalUrl(query, requestPageToken))
      if (Result.isFailure(urlResult)) return Effect.fail(urlResult.failure)
      return Effect.gen(function* () {
        let attemptNumber = 1
        while (attemptNumber <= config.maximumAttempts) {
          yield* reserveRateLimitSlot(recentRequests)
          const request = HttpClientRequest.get(urlResult.success, {
            acceptJson: true,
            headers: {
              'APCA-API-KEY-ID': key,
              'APCA-API-SECRET-KEY': secret,
            },
          })
          const responseWithBodyOutcome = yield* Effect.gen(function* () {
            const response = yield* httpClient.execute(request)
            const raw = yield* response.text
            return { response, raw }
          }).pipe(
            Effect.mapError(() =>
              failure('request', `Alpaca historical ${query.kind} request failed`, true, { pageIndex }),
            ),
            Effect.timeoutOption(Duration.millis(config.requestTimeoutMs)),
            Effect.match({
              onFailure: (error) => ({ _tag: 'failure' as const, error }),
              onSuccess: (value) => ({ _tag: 'success' as const, value }),
            }),
          )
          if (responseWithBodyOutcome._tag === 'failure') {
            if (attemptNumber >= config.maximumAttempts) return yield* responseWithBodyOutcome.error
            yield* Effect.sleep(Duration.millis(retryDelayMillis(attemptNumber)))
            attemptNumber += 1
            continue
          }
          if (Option.isNone(responseWithBodyOutcome.value)) {
            const timeout = failure(
              'timeout',
              `Alpaca historical ${query.kind} request or response body timed out`,
              true,
              { pageIndex },
            )
            if (attemptNumber >= config.maximumAttempts) return yield* timeout
            yield* Effect.sleep(Duration.millis(retryDelayMillis(attemptNumber)))
            attemptNumber += 1
            continue
          }
          const { response, raw } = responseWithBodyOutcome.value.value
          const retryableStatus = response.status === 429 || (response.status >= 500 && response.status <= 599)
          if (retryableStatus) {
            if (attemptNumber >= config.maximumAttempts) {
              return yield* failure(
                'status',
                `Alpaca historical ${query.kind} request returned HTTP ${response.status}`,
                true,
                {
                  status: response.status,
                  pageIndex,
                },
              )
            }
            const now = yield* Clock.currentTimeMillis
            const delay = retryAfterMillis(response.headers['retry-after'], now) ?? retryDelayMillis(attemptNumber)
            if (delay > config.maximumRetryDelayMs) {
              return yield* failure('status', `Alpaca historical Retry-After exceeds the bounded retry delay`, true, {
                status: response.status,
                pageIndex,
              })
            }
            yield* Effect.sleep(Duration.millis(delay))
            attemptNumber += 1
            continue
          }
          if (response.status !== 200) {
            return yield* failure(
              'status',
              `Alpaca historical ${query.kind} request returned HTTP ${response.status}`,
              false,
              {
                status: response.status,
                pageIndex,
              },
            )
          }
          return raw
        }
        return yield* failure('request', `Alpaca historical ${query.kind} request attempts were exhausted`, false, {
          pageIndex,
        })
      })
    }

    const capture = (
      input: AlpacaHistoricalQuery,
    ): Effect.Effect<VendorHistoricalCapture, VendorHistoricalFailure, FileSystem.FileSystem> =>
      requestSemaphore.withPermit(
        Effect.gen(function* () {
          const decodedQuery = validateDecodedQuery(input)
          if (Result.isFailure(decodedQuery)) return yield* decodedQuery.failure
          const query = decodedQuery.success
          const identity = queryIdentity(query)
          const queryHash = yield* canonicalHash(identity, 'historical query identity')
          const fs = yield* FileSystem.FileSystem
          const queryDirectory = yield* ensureQueryCache(fs, query, queryHash, identity)
          const rows: VendorHistoricalRow[] = []
          const seen = new Map<string, VendorHistoricalRow>()
          const pageReceipts: VendorHistoricalPageReceipt[] = []
          const rowCountsBySymbol: Record<string, number> = Object.fromEntries(
            query.symbols.map((symbol) => [symbol, 0]),
          )
          const lastSymbolEvent: { value: string | undefined } = { value: undefined }
          const seenPageTokens = new Set<string>()
          let requestPageToken: string | null = null
          let pageIndex = 0
          while (true) {
            if (pageIndex >= config.maximumPages) {
              return yield* failure('pagination', 'historical page chain exceeded its safety bound', false, {
                pageIndex,
              })
            }
            const cached = yield* readCachedPage(fs, query, queryHash, queryDirectory, pageIndex, requestPageToken)
            let page: NormalizedHistoricalPage
            let receipt: VendorHistoricalPageReceipt
            if (Option.isSome(cached)) {
              page = cached.value.normalized
              receipt = toPublicReceipt(cached.value.receipt)
            } else {
              const raw = yield* fetchPage(query, pageIndex, requestPageToken)
              const parsed = parseJson(raw, `Alpaca historical ${query.kind} page`, pageIndex)
              if (Result.isFailure(parsed)) return yield* parsed.failure
              const normalized = normalizeAlpacaHistoricalPage(query.kind, parsed.success, query, pageIndex)
              if (Result.isFailure(normalized)) return yield* normalized.failure
              const rawTextHash = sha256(raw)
              const paths = pathForPage(queryDirectory, pageIndex)
              const retrievedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
              const cachedReceipt: PageCacheReceipt = {
                schemaVersion: pageReceiptSchemaVersion,
                queryHash,
                kind: query.kind,
                pageIndex,
                requestPageToken,
                status: 200,
                retrievedAt,
                rawTextHash,
                normalizedHash: normalized.success.normalizedHash,
                rowCount: normalized.success.rows.length,
                nextPageToken: normalized.success.nextPageToken ?? null,
                bodyPath: relativePagePath(pageIndex, 'body.json'),
                receiptPath: relativePagePath(pageIndex, 'receipt.json'),
              }
              yield* writeAtomic(fs, paths.bodyPath, raw, pageIndex)
              const serializedReceipt = yield* canonicalText(cachedReceipt, 'historical page receipt', pageIndex)
              yield* writeAtomic(fs, paths.receiptPath, serializedReceipt, pageIndex)
              page = normalized.success
              receipt = toPublicReceipt(cachedReceipt)
            }
            yield* appendRows(query.kind, page.rows, rows, seen, lastSymbolEvent, pageIndex)
            for (const symbol of query.symbols) {
              rowCountsBySymbol[symbol] = (rowCountsBySymbol[symbol] ?? 0) + (page.rowCountsBySymbol[symbol] ?? 0)
            }
            pageReceipts.push(receipt)
            const nextPageToken = page.nextPageToken
            if (nextPageToken === undefined) break
            if (seenPageTokens.has(nextPageToken) || nextPageToken === requestPageToken) {
              return yield* failure('pagination', 'historical next_page_token loop detected', false, { pageIndex })
            }
            seenPageTokens.add(nextPageToken)
            requestPageToken = nextPageToken
            pageIndex += 1
          }
          const normalizedHash = yield* Effect.fromResult(normalizedRowsHashResult(rows))
          const firstPageReceipt = pageReceipts[0]
          if (firstPageReceipt === undefined) {
            return yield* failure('cache', 'historical capture has no page receipt', false)
          }
          const provenance: VendorHistoricalProvenance = {
            schemaVersion: 'bayn.vendor-historical-provenance.v1',
            source: 'alpaca-historical',
            endpointPath: endpointPath(query.kind),
            feed: alpacaHistoricalFeed,
            asof: query.sessionDate,
            marketSession: regularSession,
            timeBasis,
            completeness: 'complete',
            sessionDate: query.sessionDate,
            requestedSymbols: query.symbols,
            queryHash,
            normalizedHash,
            rowCountsBySymbol,
            pageReceipts,
            cacheKey: queryHash,
            retrievedAt: firstPageReceipt.retrievedAt,
          }
          const provenanceHash = yield* canonicalHash(provenance, 'historical provenance')
          const base = { query, queryHash, provenance, provenanceHash }
          if (query.kind === 'bars') {
            const barRows = rows.filter(isHistoricalBar)
            if (barRows.length !== rows.length) {
              return yield* failure('normalization', 'historical bars capture contains a non-bar row', false)
            }
            return {
              ...base,
              kind: 'bars',
              rows: barRows,
            }
          }
          if (query.kind === 'quotes') {
            const quoteRows = rows.filter(isHistoricalQuote)
            if (quoteRows.length !== rows.length) {
              return yield* failure('normalization', 'historical quotes capture contains a non-quote row', false)
            }
            return {
              ...base,
              kind: 'quotes',
              rows: quoteRows,
            }
          }
          const tradeRows = rows.filter(isHistoricalTrade)
          if (tradeRows.length !== rows.length) {
            return yield* failure('normalization', 'historical trades capture contains a non-trade row', false)
          }
          return {
            ...base,
            kind: 'trades',
            rows: tradeRows,
          }
        }),
      )
    return { capture }
  })
