import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted, Schema } from 'effect'

import { normalizeResearchCalendar, sha256, type Session } from './research-orb-zab-data'
import { firstDay, lastDay, listings, symbols, validationEnd } from './research-sip-momentum-protocol'

const prefix = 'bayn-research-datasets/2026-11-27'
const manifestKey = `${prefix}-sip-multiyear/MANIFEST.json`
const barsKey = `${prefix}-sip-multiyear/alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz`
const calendarKey = `${prefix}/calendar_2024_2026.json`
const manifestSha256 = '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead'
const calendarSha256 = 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71'

export class SipResearchError extends Data.TaggedError('SipResearchError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split)'),
    universes: Schema.Struct({ all62: Schema.Array(Schema.String) }),
    files: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        rows: Schema.Int,
        rawBytes: Schema.Int,
        gzipBytes: Schema.Int,
        rawSha256: Schema.String,
        gzipSha256: Schema.String,
      }),
    ),
  }),
)

export const stride = 5
export interface TapeDay {
  readonly date: string
  readonly slots: number
  readonly bars: ReadonlyMap<string, Float64Array>
}

export const slotAt = (session: Session, utcMinute: number) => (utcMinute - (session.openMs % 86_400_000) / 60_000) / 5

export const readTape = async (sessions: readonly Session[], cutoff: string, rows: AsyncIterable<string>) => {
  const dates = new Map(sessions.map((session) => [session.date, session]))
  const boundedSessions = sessions.filter((session) => session.date <= cutoff)
  const perDay = new Map(boundedSessions.map((session) => [session.date, new Map<string, Float64Array>()]))
  const seen = new Map<string, string>()
  const counts = { rows: 0, regular: 0, nonRegular: 0, preListing: 0 }
  const bySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, { received: 0, expected: 0, missing: 0 }]))
  let row = 0
  for await (const line of rows) {
    row++
    const [symbol, timestamp, o, h, l, c, v, w, extra] = line.split('\t')
    const date = timestamp?.slice(0, 10)
    if (date === undefined) throw new Error(`Missing timestamp at row ${row}`)
    // The freeze authenticates the whole compressed object, but never decodes holdout prices or volumes.
    if (date > cutoff && date <= lastDay) continue
    const session = dates.get(date)
    const bars = perDay.get(date)
    if (
      session === undefined ||
      bars === undefined ||
      !Object.hasOwn(bySymbol, symbol) ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00Z$/.test(timestamp) ||
      extra !== undefined ||
      w === undefined ||
      timestamp <= (seen.get(symbol) ?? '')
    ) {
      throw new Error(`Invalid symbol/time/order/shape at row ${row}`)
    }
    seen.set(symbol, timestamp)
    counts.rows++
    const slot = slotAt(session, Number(timestamp.slice(11, 13)) * 60 + Number(timestamp.slice(14, 16)))
    if (!Number.isInteger(slot)) throw new Error(`Off-grid SIP 5m bar at row ${row}`)
    if (slot < 0 || slot >= session.minutes / 5) {
      counts.nonRegular++
      continue
    }
    if (date < (listings[symbol] ?? firstDay)) {
      counts.preListing++
      continue
    }
    const open = Number(o)
    const high = Number(h)
    const low = Number(l)
    const close = Number(c)
    const volume = Number(v)
    const vwap = Number(w)
    if (
      !(
        low > 0 &&
        open >= low &&
        close >= low &&
        high >= open &&
        high >= close &&
        Number.isFinite(high) &&
        Number.isSafeInteger(volume) &&
        volume > 0 &&
        vwap > 0 &&
        Number.isFinite(vwap)
      )
    ) {
      throw new Error(`Invalid OHLCV at row ${row} (${symbol} ${timestamp})`)
    }
    let series = bars.get(symbol)
    if (series === undefined) bars.set(symbol, (series = new Float64Array((session.minutes / 5) * stride)))
    const offset = slot * stride
    series[offset] = open
    series[offset + 1] = high
    series[offset + 2] = low
    series[offset + 3] = close
    series[offset + 4] = volume
    counts.regular++
    bySymbol[symbol].received++
  }
  for (const symbol of symbols) {
    const symbolCounts = bySymbol[symbol]
    symbolCounts.expected = boundedSessions.reduce(
      (total, session) => total + (session.date >= (listings[symbol] ?? firstDay) ? session.minutes / 5 : 0),
      0,
    )
    symbolCounts.missing = symbolCounts.expected - symbolCounts.received
  }
  const days = boundedSessions.map(
    (session): TapeDay => ({
      date: session.date,
      slots: session.minutes / 5,
      bars: perDay.get(session.date) ?? new Map(),
    }),
  )
  return { days, row, coverage: { ...counts, bySymbol } }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let leftover = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const pieces = (leftover + decoder.decode(value, { stream: true })).split('\n')
      leftover = pieces.pop() ?? ''
      for (const line of pieces) yield line
    }
    leftover += decoder.decode()
    if (leftover.length > 0) yield leftover
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

export const loadTape = (holdout: boolean) =>
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
      accessKeyId: Redacted.value(accessKeyId),
      secretAccessKey: Redacted.value(secretAccessKey),
      region: 'us-east-1',
    })

    return yield* Effect.tryPromise({
      try: async (signal) => {
        const fetchObject = async (key: string) => {
          try {
            const response = await fetch(s3.presign(key, { expiresIn: 300 }), {
              signal,
              redirect: 'error',
              decompress: false,
            })
            if (response.ok) return response
            await response.body?.cancel()
            throw new SipResearchError({ message: `S3 read failed (${response.status}): ${key}` })
          } catch (error) {
            if (error instanceof SipResearchError) throw error
            // Never emit a signed URL as part of a transport error.
            throw new SipResearchError({ message: `S3 transport failed: ${key}` })
          }
        }
        const readJson = async (key: string, digest: string): Promise<unknown> => {
          const bytes = new Uint8Array(await (await fetchObject(key)).arrayBuffer())
          if (sha256(bytes) !== digest) throw new Error(`Frozen object mismatch: ${key}`)
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        }
        const manifest = decodeManifest(await readJson(manifestKey, manifestSha256))
        const receipt = manifest.files.find((file) => file.key === barsKey)
        if (receipt === undefined || manifest.universes.all62.toSorted().join('/') !== symbols.join('/')) {
          throw new Error('Frozen tape manifest does not match the registered object and universe')
        }
        const calendar = normalizeResearchCalendar(await readJson(calendarKey, calendarSha256))
        if (calendar.length !== 729 || calendar[0]?.date !== firstDay || calendar.at(-1)?.date !== lastDay) {
          throw new Error('Unexpected calendar coverage')
        }

        const compressed = new Bun.CryptoHasher('sha256')
        const raw = new Bun.CryptoHasher('sha256')
        let gzipBytes = 0
        let rawBytes = 0
        const response = await fetchObject(barsKey)
        if (response.body === null) throw new Error('SIP tape has no response body')
        const stream = response.body
          .pipeThrough(
            new TransformStream<Uint8Array<ArrayBuffer>, BufferSource>({
              transform(bytes, controller) {
                compressed.update(bytes)
                gzipBytes += bytes.length
                controller.enqueue(bytes)
              },
            }),
          )
          .pipeThrough(new DecompressionStream('gzip'))
          .pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(bytes, controller) {
                raw.update(bytes)
                rawBytes += bytes.length
                controller.enqueue(bytes)
              },
            }),
          )
        const tape = await readTape(calendar, holdout ? lastDay : validationEnd, lines(stream))
        if (
          tape.row !== receipt.rows ||
          gzipBytes !== receipt.gzipBytes ||
          rawBytes !== receipt.rawBytes ||
          compressed.digest('hex') !== receipt.gzipSha256 ||
          raw.digest('hex') !== receipt.rawSha256
        ) {
          throw new Error('SIP tape does not match the frozen byte/row receipt')
        }
        return { ...tape, provenance: { manifestKey, manifestSha256, calendarKey, calendarSha256, ...receipt } }
      },
      catch: (cause) =>
        cause instanceof SipResearchError
          ? cause
          : new SipResearchError({ message: 'Invalid SIP research tape', cause }),
    })
  })
