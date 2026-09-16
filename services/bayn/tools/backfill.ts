import { Clock, Config, Effect, FileSystem, Path, Redacted, Result, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { MarketCalendarResponseSchema } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../src/hash'
import { IsoDateSchema, strictParseOptions } from '../src/schemas'
import { makeAlpacaHistoricalClient } from '../src/market-data/alpaca-history/client'
import { AlpacaHistoricalKind, type VendorHistoricalCapture } from '../src/market-data/alpaca-history/model'

import { HistoricalDatasetRequestSchema, HistoricalDatasetFailure } from '../src/market-data/alpaca-history/dataset'

export const historicalCoverage = (capture: VendorHistoricalCapture) => {
  const openMs = Date.parse(capture.query.sessionOpenAt)
  const closeMs = Date.parse(capture.query.sessionCloseAt)
  return capture.query.symbols.map((symbol) => {
    const rows = capture.rows.filter((row) => row.symbol === symbol)
    const minutes = new Set(rows.map((row) => Date.parse(row.eventAt)))
    const missingMinutes: string[] = []
    if (capture.kind === 'bars') {
      for (let minute = openMs; minute < closeMs; minute += 60_000) {
        if (!minutes.has(minute)) missingMinutes.push(new Date(minute).toISOString())
      }
    }
    return {
      symbol,
      sessionDate: capture.query.sessionDate,
      kind: capture.kind,
      records: rows.length,
      firstEventAt: rows.at(0)?.eventAt ?? null,
      lastEventAt: rows.at(-1)?.eventAt ?? null,
      missingMinutes,
      coverage:
        rows.length === 0
          ? 'EMPTY'
          : missingMinutes.length > 0
            ? 'GAPPED'
            : capture.kind === 'bars'
              ? 'COMPLETE_MINUTE_GRID'
              : 'RETURNED_EVENT_STREAM',
      paginationComplete: capture.provenance.completeness === 'complete',
    }
  })
}

export const writeImmutableDatasetFile = (path: string, contents: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const verifyExisting = () =>
        fs
          .readFileString(path)
          .pipe(
            Effect.flatMap((existing) =>
              existing === contents
                ? Effect.void
                : Effect.fail(new HistoricalDatasetFailure({ message: `Immutable dataset file differs: ${path}` })),
            ),
          )
      if (yield* fs.exists(path)) return yield* verifyExisting()
      const staged = yield* fs.makeTempFileScoped({ directory: paths.dirname(path), prefix: '.bayn-history-' })
      const file = yield* fs.open(staged, { flag: 'w', mode: 0o600 })
      yield* file.writeAll(new TextEncoder().encode(contents))
      yield* file.sync
      const linked = yield* Effect.result(fs.link(staged, path))
      if (Result.isFailure(linked)) {
        if (!(yield* fs.exists(path))) return yield* linked.failure
        yield* verifyExisting()
      }
    }),
  )

/** Acquisition tooling only. This entry point is not included in the Bayn image. */
export const backfillAlpacaHistory = (input: unknown, directory: string) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(HistoricalDatasetRequestSchema, strictParseOptions)(input)
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const credentials = yield* Config.all({
      key: Config.redacted('BAYN_ALPACA_KEY_ID'),
      secret: Config.redacted('BAYN_ALPACA_SECRET_KEY'),
    })
    const historical = yield* makeAlpacaHistoricalClient(http, credentials)
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const encode = (value: unknown) =>
      Effect.fromResult(canonicalJsonV1Result(value)).pipe(Effect.map((text) => `${text}\n`))
    yield* writeImmutableDatasetFile(`${directory}/request.json`, yield* encode(request))
    const calendarPath = `${directory}/calendar.json`
    let calendarText: string
    if (yield* fs.exists(calendarPath)) calendarText = yield* fs.readFileString(calendarPath)
    else {
      const url = `https://paper-api.alpaca.markets/v2/calendar?start=${request.startDate}&end=${request.endDate}`
      calendarText = yield* Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.get(url, {
            headers: {
              'APCA-API-KEY-ID': Redacted.value(credentials.key),
              'APCA-API-SECRET-KEY': Redacted.value(credentials.secret),
            },
          }),
        )
        if (response.status !== 200)
          return yield* new HistoricalDatasetFailure({ message: `Alpaca calendar returned HTTP ${response.status}` })
        return yield* response.text
      }).pipe(
        Effect.timeout('30 seconds'),
        Effect.mapError((cause) =>
          cause instanceof HistoricalDatasetFailure
            ? cause
            : new HistoricalDatasetFailure({
                message: 'Alpaca calendar request or body failed within its 30 second deadline',
              }),
        ),
      )
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarketCalendarResponseSchema))(calendarText)
      yield* writeImmutableDatasetFile(calendarPath, calendarText)
    }
    const calendar = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarketCalendarResponseSchema))(
      calendarText,
    )
    const nowMs = yield* Clock.currentTimeMillis
    const sessions = yield* Effect.forEach(calendar, (day) =>
      Effect.fromResult(normalizeMarketCalendarResult([day], { start: day.date, end: day.date })).pipe(
        Effect.map((value) => value.sessions[0]),
      ),
    )
    if (
      sessions.some(
        (day) =>
          day === undefined ||
          day.date < request.startDate ||
          day.date > request.endDate ||
          Date.parse(day.closeAt) > nowMs,
      ) ||
      new Set(sessions.map((day) => day?.date)).size !== sessions.length ||
      sessions.length === 0
    )
      return yield* new HistoricalDatasetFailure({
        message: 'Calendar must contain unique completed sessions within the requested range',
      })
    if (request.executionSessions.some((date) => !sessions.some((day) => day?.date === date)))
      return yield* new HistoricalDatasetFailure({ message: 'Execution session is absent from the broker calendar' })
    const chunks: {
      path: string
      sha256: string
      queryHash: string
      normalizedHash: string
      kind: string
      sessionDate: string
      rowCount: number
      retrievedAt: string
    }[] = []
    const coverage: ReturnType<typeof historicalCoverage> = []
    for (const session of sessions) {
      if (session === undefined) return yield* new HistoricalDatasetFailure({ message: 'Calendar session is absent' })
      const sessionDate = yield* Schema.decodeUnknownEffect(IsoDateSchema)(session.date)
      const queries = [
        { kind: AlpacaHistoricalKind.Bars, symbols: request.symbols },
        ...(request.executionSessions.includes(sessionDate)
          ? request.symbols.flatMap((symbol) => [
              { kind: AlpacaHistoricalKind.Quotes, symbols: [symbol] },
              { kind: AlpacaHistoricalKind.Trades, symbols: [symbol] },
            ])
          : []),
      ]
      for (const query of queries) {
        const capture = yield* historical.capture({
          ...query,
          sessionDate,
          sessionOpenAt: session.openAt,
          sessionCloseAt: session.closeAt,
          startAt: session.openAt,
          endAt: session.closeAt,
          cacheDirectory: `${directory}/pages`,
        })
        const file = `chunks/${capture.queryHash}.json`
        const text = yield* encode({
          kind: capture.kind,
          rows: capture.rows,
          provenance: capture.provenance,
          provenanceHash: capture.provenanceHash,
        })
        yield* fs.makeDirectory(`${directory}/chunks`, { recursive: true })
        yield* writeImmutableDatasetFile(`${directory}/${file}`, text)
        chunks.push({
          path: file,
          sha256: sha256(text),
          queryHash: capture.queryHash,
          normalizedHash: capture.provenance.normalizedHash,
          kind: capture.kind,
          sessionDate: session.date,
          rowCount: capture.rows.length,
          retrievedAt: capture.provenance.retrievedAt,
        })
        coverage.push(...historicalCoverage(capture))
      }
      yield* Effect.logInfo('Alpaca historical session retained').pipe(
        Effect.annotateLogs({
          sessionDate: session.date,
          completedSessions: chunks.filter((chunk) => chunk.kind === 'bars').length,
          totalSessions: sessions.length,
        }),
      )
    }
    const coverageText = yield* encode(coverage)
    yield* writeImmutableDatasetFile(`${directory}/coverage.json`, coverageText)
    const manifest = {
      schemaVersion: 'bayn.alpaca-history-dataset.v1',
      request,
      provider: 'alpaca',
      transport: 'historical-rest',
      feed: 'iex',
      adjustment: 'raw',
      originalStreamAvailability: 'NOT_OBSERVED',
      revisionKnowledge: 'REST_AS_OF_RETRIEVAL',
      calendar: { path: 'calendar.json', sha256: sha256(calendarText) },
      coverage: { path: 'coverage.json', sha256: sha256(coverageText), rows: coverage.length },
      chunks,
      recordCount: chunks.reduce((total, chunk) => total + chunk.rowCount, 0),
    }
    const datasetId = yield* Effect.fromResult(canonicalHashV1Result(manifest))
    yield* writeImmutableDatasetFile(`${directory}/dataset.json`, yield* encode({ ...manifest, datasetId }))
    return { datasetId, sessions: sessions.length, records: manifest.recordCount }
  })
