import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { Config, Effect, Redacted, Result, Schema } from 'effect'

import {
  candidateDevelopmentCalendarContract,
  officialMonthEndSignalDates,
  type CandidateDevelopmentPreflightPass,
} from '../../candidate-development'
import { frozenCandidateDevelopmentSessions } from '../../candidate-development-calendar'
import {
  candidateDevelopmentExecutableProgramSchemaVersion,
  type CandidateDevelopmentExecutableProgram,
} from '../../candidate-development-command'
import { sha256 } from '../../hash'
import type { SnapshotRequest } from '../../market-data/model'
import { decodeManifests, type SignalManifestRow } from '../../market-data/rows'
import { verifyManifest } from '../../market-data/verification/manifest'
import { strictParseOptions } from '../../schemas'
import { candidate16DatasetHashes, evaluateCandidate16Development } from './development'
import {
  CANDIDATE_16_DEVELOPMENT_END,
  CANDIDATE_16_DEVELOPMENT_START,
  CANDIDATE_16_ORDINAL,
  CANDIDATE_16_PREREGISTRATION_COMMIT,
  CANDIDATE_16_PREREGISTRATION_SHA256,
  CANDIDATE_16_PRIOR_TRIAL_COUNT,
  CANDIDATE_16_SNAPSHOT_ID,
  CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
  candidate16Specification,
  candidate16Universe,
  type Candidate16Bar,
  type Candidate16Dataset,
  type Candidate16Failure,
  type Candidate16Registration,
} from './model'

const BarRowSchema = Schema.Struct({
  symbol: Schema.String,
  session_date: Schema.String,
  adjusted_open: Schema.String,
  adjusted_high: Schema.String,
  adjusted_low: Schema.String,
  adjusted_close: Schema.String,
  adjusted_volume: Schema.String,
})
const BarRowsSchema = Schema.Array(BarRowSchema)

interface Candidate16CommandConfig {
  readonly clickhouseUrl: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: Redacted.Redacted<string>
  readonly evaluatedCommit: string
  readonly preregistrationBase64: string
}

interface Candidate16ProgramRegistration {
  readonly registration: Candidate16Registration
  readonly config: Candidate16CommandConfig
}

interface Candidate16ProgramData {
  readonly registration: Candidate16Registration
  readonly dataset: Candidate16Dataset
}

const commandConfig = Config.all({
  clickhouseUrl: Config.string('BAYN_CLICKHOUSE_URL'),
  clickhouseUsername: Config.string('BAYN_CLICKHOUSE_USERNAME'),
  clickhousePassword: Config.redacted('BAYN_CLICKHOUSE_PASSWORD'),
  evaluatedCommit: Config.string('BAYN_CANDIDATE_16_EVALUATED_COMMIT'),
  preregistrationBase64: Config.string('BAYN_CANDIDATE_16_PREREGISTRATION_BASE64').pipe(Config.withDefault('')),
})

const ioFailure = (operation: string, cause: unknown): Candidate16Failure => ({
  _tag: 'Candidate16IoFailure',
  operation,
  cause,
})

const invalidInput = (operation: string, reason: string): Candidate16Failure => ({
  _tag: 'Candidate16InvalidInput',
  operation,
  reason,
})

const sha256Bytes = (bytes: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest('hex')

const preregistrationBytes = (encoded: string): Effect.Effect<Uint8Array, Candidate16Failure> =>
  encoded.length === 0
    ? Effect.tryPromise({
        try: () =>
          readFile(new URL('../../../candidates/ordinal-16-macro-breadth-regime-preregistration.md', import.meta.url)),
        catch: (cause) => ioFailure('read-preregistration', cause),
      })
    : Effect.try({
        try: () => Uint8Array.from(Buffer.from(encoded, 'base64')),
        catch: (cause) => ioFailure('decode-preregistration', cause),
      })

const preregisterCandidate = (
  config: Candidate16CommandConfig,
): Effect.Effect<Candidate16Registration, Candidate16Failure> =>
  preregistrationBytes(config.preregistrationBase64).pipe(
    Effect.flatMap((bytes) => {
      const preregistrationHash = sha256Bytes(bytes)
      if (preregistrationHash !== CANDIDATE_16_PREREGISTRATION_SHA256) {
        return Effect.fail(
          invalidInput(
            'preregister',
            `preregistration hash ${preregistrationHash} differs from ${CANDIDATE_16_PREREGISTRATION_SHA256}`,
          ),
        )
      }
      if (!/^[0-9a-f]{40}$/.test(config.evaluatedCommit)) {
        return Effect.fail(
          invalidInput('preregister', 'evaluated commit must be a lowercase 40-character Git object id'),
        )
      }
      return Effect.succeed({
        preregistrationHash: CANDIDATE_16_PREREGISTRATION_SHA256,
        preregistrationCommit: CANDIDATE_16_PREREGISTRATION_COMMIT,
        evaluatedCommit: config.evaluatedCommit,
      })
    }),
  )

const acquireClickHouse = (config: Candidate16CommandConfig): Effect.Effect<ClickHouseClient, Candidate16Failure> =>
  Effect.try({
    try: () =>
      createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: Redacted.value(config.clickhousePassword),
        application: 'bayn-candidate-16-development',
        clickhouse_settings: { readonly: '1' },
      }),
    catch: (cause) => ioFailure('create-clickhouse-client', cause),
  })

const parsedNumber = (field: string, value: string): Result.Result<number, Candidate16Failure> => {
  const number = Number(value)
  return Number.isFinite(number)
    ? Result.succeed(number)
    : Result.fail(invalidInput('decode-bars', `${field} is ${value}`))
}

const candidate16Bar = (row: typeof BarRowSchema.Type): Result.Result<Candidate16Bar, Candidate16Failure> => {
  if (!candidate16Universe.includes(row.symbol as Candidate16Bar['symbol'])) {
    return Result.fail(invalidInput('decode-bars', `unexpected symbol ${row.symbol}`))
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.session_date)) {
    return Result.fail(invalidInput('decode-bars', `invalid session date ${row.session_date}`))
  }
  return Result.all({
    open: parsedNumber('adjusted_open', row.adjusted_open),
    high: parsedNumber('adjusted_high', row.adjusted_high),
    low: parsedNumber('adjusted_low', row.adjusted_low),
    close: parsedNumber('adjusted_close', row.adjusted_close),
    volume: parsedNumber('adjusted_volume', row.adjusted_volume),
  }).pipe(
    Result.map((values) => ({
      symbol: row.symbol as Candidate16Bar['symbol'],
      sessionDate: row.session_date as Candidate16Bar['sessionDate'],
      ...values,
    })),
  )
}

export const queryCandidate16DevelopmentBars = (
  client: ClickHouseClient,
): Effect.Effect<readonly Candidate16Bar[], Candidate16Failure> =>
  Effect.tryPromise({
    try: async () => {
      const result = await client.query({
        query: `
          SELECT
            symbol,
            toString(session_date) AS session_date,
            toDecimalString(adjusted_open, 8) AS adjusted_open,
            toDecimalString(adjusted_high, 8) AS adjusted_high,
            toDecimalString(adjusted_low, 8) AS adjusted_low,
            toDecimalString(adjusted_close, 8) AS adjusted_close,
            toDecimalString(adjusted_volume, 8) AS adjusted_volume
          FROM signal.adjusted_daily_bars_v2
          WHERE snapshot_id = {snapshotId:String}
            AND symbol IN {symbols:Array(String)}
            AND toString(session_date) >= {start:String}
            AND toString(session_date) <= {end:String}
          ORDER BY session_date, symbol
        `,
        query_params: {
          snapshotId: CANDIDATE_16_SNAPSHOT_ID,
          symbols: candidate16Universe,
          start: CANDIDATE_16_DEVELOPMENT_START,
          end: CANDIDATE_16_DEVELOPMENT_END,
        },
        format: 'JSONEachRow',
        query_id: 'bayn-candidate-16-development-bars-one-shot',
      })
      return result.json<unknown>()
    },
    catch: (cause) => ioFailure('query-development-bars', cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BarRowsSchema, strictParseOptions)),
    Effect.mapError((cause) => ioFailure('decode-development-bars', cause)),
    Effect.flatMap((rows) => Effect.fromResult(Result.all(rows.map(candidate16Bar)))),
  )

export const candidate16ManifestVerificationRequest = (
  manifest: SignalManifestRow,
  preflight: CandidateDevelopmentPreflightPass,
  observedAt: string,
): Result.Result<SnapshotRequest, Candidate16Failure> => {
  if (
    manifest.requested_start > CANDIDATE_16_DEVELOPMENT_START ||
    manifest.first_session > CANDIDATE_16_DEVELOPMENT_START ||
    manifest.last_session < CANDIDATE_16_DEVELOPMENT_END ||
    manifest.publication_asof < CANDIDATE_16_DEVELOPMENT_END
  ) {
    return Result.fail(
      invalidInput(
        'verify-development-manifest',
        `snapshot ${manifest.first_session}..${manifest.last_session} as-of ${manifest.publication_asof} does not cover the frozen development subset`,
      ),
    )
  }
  return Result.succeed({
    snapshotId: CANDIDATE_16_SNAPSHOT_ID,
    publicationAsOf: manifest.publication_asof,
    calendarVersion: candidateDevelopmentCalendarContract.calendarVersion,
    universe: candidate16Universe,
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: manifest.requested_start,
      dataEnd: manifest.publication_asof,
      lookbackStart: manifest.requested_start,
      evaluationStart: preflight.selectedObservationStart,
      evaluationEnd: manifest.publication_asof,
    },
    observedAt,
    universeId: manifest.universe_id,
    universeSymbolHash: sha256(candidate16Universe.join(',')),
    historyStart: manifest.requested_start,
    evaluationStart: preflight.selectedObservationStart,
  })
}

export const queryCandidate16FinalizedSnapshot = (
  client: ClickHouseClient,
  preflight: CandidateDevelopmentPreflightPass,
) =>
  Effect.tryPromise({
    try: async () => {
      const result = await client.query({
        query: `
          SELECT
            snapshot_id,
            schema_version,
            publisher_source_revision,
            publisher_image_repository,
            publisher_image_digest,
            universe_id,
            universe_symbol_hash,
            provider,
            source_feed,
            adjustment,
            calendar_version,
            toString(requested_start) AS requested_start,
            toString(publication_asof) AS publication_asof,
            toString(first_session) AS first_session,
            toString(last_session) AS last_session,
            symbol_count,
            session_count,
            bar_count,
            bars_content_hash,
            sessions_content_hash,
            manifest_content_hash,
            toString(finalized_at) AS finalized_at
          FROM signal.snapshot_manifests_v2
          WHERE snapshot_id = {snapshotId:String}
          ORDER BY finalized_at
        `,
        query_params: { snapshotId: CANDIDATE_16_SNAPSHOT_ID },
        format: 'JSONEachRow',
        query_id: 'bayn-candidate-16-development-manifest-one-shot',
      })
      return result.json<readonly unknown[]>()
    },
    catch: (cause) => ioFailure('query-development-manifest', cause),
  }).pipe(
    Effect.flatMap((rows) =>
      Effect.fromResult(
        decodeManifests(rows).pipe(
          Result.mapError((cause): Candidate16Failure => ({ _tag: 'Candidate16QualificationFailure', cause })),
          Result.flatMap((manifests) => {
            const manifest = manifests.at(0)
            if (manifest === undefined)
              return Result.fail(invalidInput('verify-development-manifest', 'manifest missing'))
            return candidate16ManifestVerificationRequest(manifest, preflight, new Date().toISOString()).pipe(
              Result.flatMap((request) =>
                verifyManifest(manifests, request).pipe(
                  Result.mapError((cause): Candidate16Failure => ({ _tag: 'Candidate16QualificationFailure', cause })),
                  Result.map(({ finalizedSnapshot }) => finalizedSnapshot),
                ),
              ),
            )
          }),
        ),
      ),
    ),
  )

const loadDevelopmentData = (
  config: Candidate16CommandConfig,
  preflight: CandidateDevelopmentPreflightPass,
): Effect.Effect<Candidate16Dataset, Candidate16Failure> =>
  Effect.scoped(
    Effect.acquireRelease(acquireClickHouse(config), (client) =>
      Effect.tryPromise({
        try: () => client.close(),
        catch: (cause) => ioFailure('close-clickhouse-client', cause),
      }).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((client) =>
        queryCandidate16FinalizedSnapshot(client, preflight).pipe(
          Effect.flatMap((finalizedSnapshot) =>
            queryCandidate16DevelopmentBars(client).pipe(
              Effect.flatMap((bars) => {
                const sessions = frozenCandidateDevelopmentSessions()
                return Effect.fromResult(
                  candidate16DatasetHashes(sessions, bars).pipe(
                    Result.map((hashes) => ({
                      snapshotId: CANDIDATE_16_SNAPSHOT_ID,
                      finalizedSnapshot,
                      sessions,
                      bars,
                      ...hashes,
                    })),
                  ),
                )
              }),
            ),
          ),
        ),
      ),
    ),
  )

const officialSessions = frozenCandidateDevelopmentSessions()

export const candidateDevelopmentProgram: CandidateDevelopmentExecutableProgram<
  Candidate16ProgramRegistration,
  Candidate16ProgramData,
  Candidate16Failure,
  never
> = {
  schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
  input: {
    candidateOrdinal: CANDIDATE_16_ORDINAL,
    priorTrialCount: CANDIDATE_16_PRIOR_TRIAL_COUNT,
    expectedStrategyProtocolHash: CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
    officialSessions,
    signalSessionDates: officialMonthEndSignalDates(officialSessions),
    featureLookbackSessions: candidate16Specification.lookbackSessions,
  },
  effects: {
    preregisterCandidate: () =>
      commandConfig.pipe(
        Effect.mapError((cause) => ioFailure('load-config', cause)),
        Effect.flatMap((config) =>
          preregisterCandidate(config).pipe(Effect.map((registration) => ({ registration, config }))),
        ),
      ),
    loadDevelopmentData: ({ config, registration }, preflight) =>
      loadDevelopmentData(config, preflight).pipe(Effect.map((dataset) => ({ registration, dataset }))),
    evaluateDevelopment: ({ dataset, registration }, preflight) =>
      Effect.fromResult(evaluateCandidate16Development(registration, dataset, preflight)),
  },
}
