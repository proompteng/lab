import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { receipts } from './pure-etf-dual-horizon-data'
import { Asset, assets, markTape, protocol, Regime, scoreStudy, Verdict } from './research-10yr-vol-parity-switch-core'
import { withS3Archive } from './research-lib/s3-archive'
import { controlIds, prepareControls } from './research/event-calendar-etf-controls'
import { loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'

const base = receipts.datasets.daily
const manifestKey = `${base.prefix}/MANIFEST.json`
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])'),
    etfs: Schema.Array(Schema.String),
    files: Schema.Tuple([
      Schema.Struct({
        key: Schema.Literal(`${base.prefix}/${base.name}`),
        rows: Schema.Literal(base.rows),
        gzipBytes: Schema.Literal(base.bytes),
        gzipSha256: Schema.Literal(base.sha256),
        rawBytes: Schema.Literal(base.rawBytes),
        rawSha256: Schema.Literal(base.rawSha256),
      }),
    ]),
  }),
)
const decodeAssets = Schema.decodeUnknownSync(Schema.Array(Schema.Enum(Asset)))
const requiredAssets = new Set<string>(assets)

export const verifyBaseManifest = (input: unknown) => {
  const { source, etfs, files } = decodeManifest(input)
  const symbols = decodeAssets(etfs.filter((symbol) => requiredAssets.has(symbol)))
  if (new Set(etfs).size !== etfs.length || symbols.length !== requiredAssets.size)
    throw new Error('Base SIP manifest must uniquely list all six registered candidate assets')
  return { source, symbols, manifestKey, manifestSha256: base.manifestSha256, tape: files[0] }
}

const encodeIdentity = Schema.encodeSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.wave24a.vol-parity-switch.v1'),
    verdict: Schema.Enum(Verdict),
    regimeSessions: Schema.Array(Schema.Struct({ regime: Schema.Enum(Regime), count: Schema.Int })),
  }),
)

class StudyError extends Data.TaggedError('VolParityStudyError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const failure = (message: string) => (cause: unknown) => new StudyError({ message, cause: Redacted.make(cause) })

const main = Effect.gen(function* () {
  const output = yield* Effect.try({
    try: () => {
      const { values } = parseArgs({ options: { output: { type: 'string' } } })
      if (values.output === undefined || values.output === '') throw new Error('Missing output path')
      return values.output
    },
    catch: failure('Usage: research-10yr-vol-parity-switch.ts --output <new results.json path>'),
  })
  const manifest = yield* withS3Archive(async (archive) =>
    verifyBaseManifest(await archive.readJson(manifestKey, base.manifestSha256)),
  ).pipe(Effect.timeout('30 seconds'), Effect.mapError(failure('Unable to verify the base SIP manifest')))
  // The existing daily loader binds both tapes and calendars and only admits DIA/UUP from the supplement.
  const daily = yield* loadFrozenDailyFrames.pipe(
    Effect.mapError(failure('Unable to verify adjusted daily SIP frames')),
  )
  const intraday = yield* withArchive(async (archive) => {
    const dev = await loadDevelopment(archive)
    const recent = await loadHoldout(archive)
    return [...dev.days, ...recent.days]
  }).pipe(Effect.timeout('5 minutes'), Effect.mapError(failure('Unable to verify B0 intraday frames')))
  const results = yield* Effect.try({
    try: () => {
      const control = prepareControls(daily, intraday)
      const { verdict, regimeSessions, ...scores } = scoreStudy(markTape(daily), control.at)
      return {
        ...encodeIdentity({ schemaVersion: 'bayn.wave24a.vol-parity-switch.v1', verdict, regimeSessions }),
        input: {
          candidate: manifest,
          sessions: daily.length,
          first: daily[0].date,
          last: daily[daily.length - 1].date,
          verifiedBarsPerCandidateAsset: daily.length,
          controlReceipts: receipts,
        },
        protocol,
        protocolSha256: sha256(JSON.stringify(protocol)),
        controls: { ids: controlIds, oracle: control.oracle },
        ...scores,
      }
    },
    catch: failure('Unable to score the registered switch against all controls'),
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(results, null, 2) + '\n', { signal, flag: 'wx', mode: 0o600 }),
    catch: failure('Unable to create new study evidence'),
  })
  yield* Effect.logInfo(
    `${results.verdict}: ${results.scoredSessions} matched sessions, ${results.pooledOosSessions} OOS`,
  )
})

if (import.meta.main) NodeRuntime.runMain(main)
