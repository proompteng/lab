import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted, Schema } from 'effect'

import { IsoDateSchema } from '../src/schemas'
import { blind, listingDates, prior, universe } from './8yr-unseen-intraday-protocol'
import { isListed, readTape } from './8yr-unseen-intraday-tape'
import { normalizeResearchCalendar, sha256 } from './research-orb-zab-data'

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const object = Schema.Struct({ key: Schema.String, bytes: count, sha256: digest })
const decodeBlindManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    dataset: Schema.Literal('alpaca-sip-8yr-5m-unseen-2016-2023'),
    source: Schema.Literal('Alpaca Data API v2 (feed=sip, adjustment=split, timeframe=5Min)'),
    dateRange: Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema }),
    calendarSessions: count,
    symbolCount: count,
    symbols: Schema.Array(Schema.String),
    symbolRowCounts: Schema.Record(Schema.String, count),
    totalRows: count,
    files: Schema.Struct({ bars_5m: object, calendar: object }),
  }),
)
const decodeBlindCalendar = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      date: IsoDateSchema,
      open: Schema.Literal('09:30'),
      close: Schema.Literals(['13:00', '16:00']),
    }),
  ),
)
const decodePriorManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split)'),
    universes: Schema.Struct({ all62: Schema.Array(Schema.String) }),
    files: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        rows: count,
        rawBytes: count,
        gzipBytes: count,
        rawSha256: digest,
        gzipSha256: digest,
      }),
    ),
  }),
)

export const compareUniverse = (declared: readonly string[], rows?: Readonly<Record<string, number>>) => {
  const expected = new Set(universe)
  const actual = new Set(declared)
  return {
    missing: universe.filter((symbol) => !actual.has(symbol)),
    unexpected: [...actual].filter((symbol) => !expected.has(symbol)).sort(),
    duplicates: [...new Set(declared.filter((symbol, i) => declared.indexOf(symbol) !== i))].sort(),
    listedWithoutRows:
      rows === undefined
        ? []
        : universe.filter((symbol) => (listingDates[symbol] ?? blind.first) <= blind.last && !(rows[symbol] > 0)),
  }
}

export const admitUniverse = (label: string, declared: readonly string[], rows?: Readonly<Record<string, number>>) => {
  const problems = Object.entries(compareUniverse(declared, rows)).filter(([, symbols]) => symbols.length > 0)
  if (problems.length > 0) {
    throw new Error(
      `${label} universe differs from the frozen roster: ${problems.map(([issue, names]) => `${issue}=[${names.join(', ')}]`).join('; ')}`,
    )
  }
}

type Window = Pick<typeof blind | typeof prior, 'first' | 'last' | 'sessions'>
const checkCalendar = (input: unknown, window: Window) => {
  const calendar = normalizeResearchCalendar(input)
  if (
    calendar.length !== window.sessions ||
    calendar[0]?.date !== window.first ||
    calendar.at(-1)?.date !== window.last ||
    new Set(calendar.map(({ date }) => date)).size !== calendar.length
  ) {
    throw new Error(`Calendar does not cover ${window.sessions} unique sessions for ${window.first}–${window.last}`)
  }
  return calendar
}

const checkBlindManifest = (input: unknown) => {
  const manifest = decodeBlindManifest(input)
  const { symbols, symbolRowCounts, files } = manifest
  if (
    manifest.dateRange.start !== blind.first ||
    manifest.dateRange.end !== blind.last ||
    manifest.calendarSessions !== blind.sessions ||
    manifest.symbolCount !== symbols.length ||
    manifest.totalRows !== blind.rows ||
    Object.values(symbolRowCounts).reduce((total, rows) => total + rows, 0) !== blind.rows ||
    Object.keys(symbolRowCounts).some((symbol) => !symbols.includes(symbol)) ||
    files.bars_5m.key !== blind.bars ||
    files.bars_5m.bytes <= 0 ||
    files.calendar.key !== blind.calendar ||
    files.calendar.sha256 !== blind.calendarSha256
  ) {
    throw new Error('Blind manifest does not match the registered archive receipt')
  }
  return manifest
}

export const readArchiveMetadata = async (read: (key: string, sha256: string) => Promise<unknown>) => {
  const source = checkBlindManifest(await read(blind.manifest, blind.manifestSha256))
  // Never treat an entirely absent early-listed name like an ordinary missing 5m bar.
  admitUniverse('2016–2023 blind SIP', source.symbols, source.symbolRowCounts)
  const blindCalendar = checkCalendar(
    {
      query: { start: blind.first, end: blind.last },
      response: decodeBlindCalendar(await read(blind.calendar, blind.calendarSha256)),
    },
    blind,
  )
  const continuity = decodePriorManifest(await read(prior.manifest, prior.manifestSha256))
  admitUniverse('2024–2026 continuity SIP', continuity.universes.all62)
  const priorTape = continuity.files.filter(({ key }) => key === prior.bars)
  if (priorTape.length !== 1 || priorTape[0].rows !== prior.rows) throw new Error('Missing registered continuity tape')
  const priorCalendar = checkCalendar(await read(prior.calendar, prior.calendarSha256), prior)
  return {
    blind: { calendar: blindCalendar, receipt: source.files.bars_5m, rowsBySymbol: source.symbolRowCounts },
    prior: { calendar: priorCalendar, receipt: priorTape[0] },
  }
}

export class ArchiveError extends Data.TaggedError('ArchiveError')<{ readonly message: string }> {}

export const withArchive = <A>(
  run: (
    read: (key: string, digest: string) => Promise<unknown>,
    open: (key: string) => Promise<Response>,
    signal: AbortSignal,
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const endpoint = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_ENDPOINT').pipe(
      Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
    )
    const bucket = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts'))
    const accessKeyId = yield* Config.Redacted('AWS_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.Redacted('AWS_SECRET_ACCESS_KEY')
    const s3 = new S3Client({
      endpoint,
      bucket,
      region: 'us-east-1',
      accessKeyId: Redacted.value(accessKeyId),
      secretAccessKey: Redacted.value(secretAccessKey),
    })
    return yield* Effect.tryPromise({
      try: (signal) => {
        const open = async (key: string) => {
          const response = await fetch(s3.presign(key, { expiresIn: 300 }), {
            signal,
            redirect: 'error',
            decompress: false,
          }).catch(() => {
            // A transport cause could contain a presigned URL. Report only the public object name.
            throw new ArchiveError({ message: `S3 transport failed: ${key}` })
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw new ArchiveError({ message: `S3 read failed (${response.status}): ${key}` })
          }
          return response
        }
        return run(
          async (key, expected) => {
            const bytes = await (await open(key)).bytes()
            if (sha256(bytes) !== expected) throw new ArchiveError({ message: `S3 SHA-256 mismatch: ${key}` })
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
          },
          open,
          signal,
        )
      },
      catch: (cause) => new ArchiveError({ message: cause instanceof Error ? cause.message : String(cause) }),
    })
  })

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let rest = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const pieces = (rest + decoder.decode(value, { stream: true })).split('\n')
      rest = pieces.pop() ?? ''
      yield* pieces
    }
    rest += decoder.decode()
    if (rest.length > 0) yield rest
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

export const loadTapes = async (
  read: (key: string, digest: string) => Promise<unknown>,
  open: (key: string) => Promise<Response>,
) => {
  // Both universe/calendar receipts must be admitted before the first bar GET.
  const metadata = await readArchiveMetadata(read)
  const load = async (kind: 'blind' | 'prior') => {
    const { calendar, receipt } = metadata[kind]
    const compressed = new Bun.CryptoHasher('sha256')
    const raw = new Bun.CryptoHasher('sha256')
    let gzipBytes = 0
    let rawBytes = 0
    const body = (await open(receipt.key)).body
    if (body === null) throw new Error(`Missing S3 body: ${receipt.key}`)
    const stream = body
      .pipeThrough(
        new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
          transform(chunk, controller) {
            gzipBytes += chunk.length
            compressed.update(chunk)
            controller.enqueue(chunk)
          },
        }),
      )
      .pipeThrough(new DecompressionStream('gzip'))
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            rawBytes += chunk.length
            raw.update(chunk)
            controller.enqueue(chunk)
          },
        }),
      )
    const tape = await readTape(
      calendar,
      lines(stream),
      kind,
      kind === 'blind' ? blind.rows : prior.rows,
      kind === 'blind' ? metadata.blind.rowsBySymbol : undefined,
    )
    if (
      gzipBytes !== ('gzipBytes' in receipt ? receipt.gzipBytes : receipt.bytes) ||
      compressed.digest('hex') !== ('gzipSha256' in receipt ? receipt.gzipSha256 : receipt.sha256) ||
      ('rawSha256' in receipt && (rawBytes !== receipt.rawBytes || raw.digest('hex') !== receipt.rawSha256))
    ) {
      throw new Error(`Byte receipt mismatch: ${receipt.key}`)
    }
    const missing = universe.filter(
      (symbol) => calendar.some(({ date }) => isListed(symbol, date)) && !tape.supported.has(symbol),
    )
    if (missing.length > 0) throw new Error(`${kind} SIP lacks any admitted RTH bars for: ${missing.join(', ')}`)
    return { days: tape.days, coverage: tape.coverage, receipt }
  }
  return { blind: await load('blind'), prior: await load('prior') }
}
