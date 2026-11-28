import { gunzipSync } from 'node:zlib'
import { Schema } from 'effect'

import { hash, type Bar, type Session } from './vol-regime-carry-data'

const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schema: Schema.Literal('bayn.wave10d.tip.v1'),
    symbol: Schema.Literal('TIP'),
    feed: Schema.Literal('sip'),
    adjustment: Schema.Literal('all'),
    timeframe: Schema.Literal('1Day'),
    first: Schema.Literal('2016-01-04'),
    last: Schema.Literal('2026-11-25'),
    sessions: Schema.Literal(2741),
    gzipSha256: sha256,
    rawSha256: sha256,
  }),
)

export const verifyTip = (manifest: Uint8Array, bytes: Uint8Array, pinnedSha256: string) => {
  if (hash(manifest) !== pinnedSha256) throw new Error('TIP manifest SHA-256 mismatch')
  const receipt = decodeManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest)))
  if (hash(bytes) !== receipt.gzipSha256) throw new Error('TIP gzip SHA-256 mismatch')
  const raw = gunzipSync(bytes)
  if (hash(raw) !== receipt.rawSha256) throw new Error('TIP raw SHA-256 mismatch')
  return { manifestSha256: pinnedSha256, ...receipt, raw }
}

export const attachTip = (sessions: readonly Session[], raw: Uint8Array): Session[] => {
  const last = sessions.at(-1)?.date
  const bars = new Map<string, Bar>()
  let previous = ''
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\n')) {
    if (line === '') continue
    const date = line.slice(4, 14)
    if (!/^TIP\t\d{4}-\d{2}-\d{2}T0[45]:00:00(?:\.\d+)?Z\t/.test(line) || date <= previous)
      throw new Error(`Invalid or out-of-order TIP timestamp: ${date}`)
    previous = date
    // The archive is ordered by date. Do not decode any price fields beyond the active fold.
    if (last === undefined || date > last) {
      if (last === '2026-11-25') throw new Error(`TIP extends beyond the frozen calendar: ${date}`)
      break
    }
    const cells = line.split('\t')
    const [open, high, low, close, volume, vwap] = cells.slice(2).map(Number)
    if (
      cells.length !== 8 ||
      [open, high, low, close, volume, vwap].some((value) => !Number.isFinite(value) || value <= 0) ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close)
    )
      throw new Error(`Invalid TIP daily bar: ${date}`)
    bars.set(date, { open, close })
  }
  if (bars.size !== sessions.length) throw new Error('TIP daily calendar does not match frozen SIP calendar')
  return sessions.map((session) => {
    const bar = bars.get(session.date)
    if (bar === undefined) throw new Error(`Missing TIP bar on ${session.date}`)
    return { ...session, bars: [...session.bars, bar] }
  })
}
