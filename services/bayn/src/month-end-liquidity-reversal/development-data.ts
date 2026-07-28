import { Result } from 'effect'

import { sha256 } from '../hash'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import type { Candidate6DevelopmentDataset } from './model'

const EXPECTED_HEADER = [
  'symbol',
  'toString(session_date)',
  'toString(adjusted_open)',
  'toString(adjusted_high)',
  'toString(adjusted_low)',
  'toString(adjusted_close)',
  'toString(adjusted_volume)',
  'provider',
  'source_feed',
  'adjustment',
] as const

export type Candidate6DevelopmentDataFailure =
  | { readonly _tag: 'InvalidCsv'; readonly row: number; readonly reason: string }
  | { readonly _tag: 'InvalidCsvHeader'; readonly observed: readonly string[] }
  | { readonly _tag: 'InvalidCsvFieldCount'; readonly row: number; readonly observed: number }
  | { readonly _tag: 'InvalidCsvDate'; readonly row: number; readonly observed: string }
  | { readonly _tag: 'InvalidCsvNumber'; readonly row: number; readonly field: string; readonly observed: string }
  | { readonly _tag: 'InvalidCsvEnum'; readonly row: number; readonly field: string; readonly observed: string }
  | { readonly _tag: 'EmptyDevelopmentDataset' }

type DataResult<A> = Result.Result<A, Candidate6DevelopmentDataFailure>

const fail = <A>(failure: Candidate6DevelopmentDataFailure): DataResult<A> => Result.fail(failure)

const parseCsvRows = (input: string): DataResult<readonly (readonly string[])[]> => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? ''
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      if (field.length > 0) return fail({ _tag: 'InvalidCsv', row: rows.length + 1, reason: 'quote-after-data' })
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) return fail({ _tag: 'InvalidCsv', row: rows.length + 1, reason: 'unterminated-quote' })
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field)
    rows.push(row)
  }
  return Result.succeed(rows)
}

const finiteNumber = (row: number, field: string, observed: string): DataResult<number> => {
  const value = Number(observed)
  return Number.isFinite(value) ? Result.succeed(value) : fail({ _tag: 'InvalidCsvNumber', row, field, observed })
}

const isoDate = (row: number, observed: string): DataResult<IsoDate> =>
  /^\d{4}-\d{2}-\d{2}$/.test(observed)
    ? Result.succeed(observed as IsoDate)
    : fail({ _tag: 'InvalidCsvDate', row, observed })

const decodeBar = (fields: readonly string[], row: number): DataResult<DailyBar> => {
  if (fields.length !== EXPECTED_HEADER.length) {
    return fail({ _tag: 'InvalidCsvFieldCount', row, observed: fields.length })
  }
  const [symbol, rawDate, rawOpen, rawHigh, rawLow, rawClose, rawVolume, provider, feed, adjustment] = fields
  const sessionDate = isoDate(row, rawDate ?? '')
  if (Result.isFailure(sessionDate)) return fail(sessionDate.failure)
  const numbers = [
    ['open', rawOpen ?? ''],
    ['high', rawHigh ?? ''],
    ['low', rawLow ?? ''],
    ['close', rawClose ?? ''],
    ['volume', rawVolume ?? ''],
  ] as const
  const decodedNumbers: number[] = []
  for (const [field, observed] of numbers) {
    const decoded = finiteNumber(row, field, observed)
    if (Result.isFailure(decoded)) return fail(decoded.failure)
    decodedNumbers.push(decoded.success)
  }
  if (provider !== DataSource.Alpaca) {
    return fail({ _tag: 'InvalidCsvEnum', row, field: 'provider', observed: provider ?? '' })
  }
  if (feed !== DataFeed.Sip) {
    return fail({ _tag: 'InvalidCsvEnum', row, field: 'source_feed', observed: feed ?? '' })
  }
  if (adjustment !== PriceAdjustment.All) {
    return fail({ _tag: 'InvalidCsvEnum', row, field: 'adjustment', observed: adjustment ?? '' })
  }
  return Result.succeed({
    symbol: symbol ?? '',
    sessionDate: sessionDate.success,
    open: decodedNumbers[0] ?? Number.NaN,
    high: decodedNumbers[1] ?? Number.NaN,
    low: decodedNumbers[2] ?? Number.NaN,
    close: decodedNumbers[3] ?? Number.NaN,
    volume: decodedNumbers[4] ?? Number.NaN,
    source: DataSource.Alpaca,
    sourceFeed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
  })
}

export const parseCandidate6DevelopmentCsv = (
  csv: string,
  snapshotId: string,
): DataResult<Candidate6DevelopmentDataset> => {
  const rows = parseCsvRows(csv)
  if (Result.isFailure(rows)) return fail(rows.failure)
  const [header, ...body] = rows.success
  if (
    header === undefined ||
    header.length !== EXPECTED_HEADER.length ||
    header.some((field, index) => field !== EXPECTED_HEADER[index])
  ) {
    return fail({ _tag: 'InvalidCsvHeader', observed: header ?? [] })
  }
  const bars: DailyBar[] = []
  for (let index = 0; index < body.length; index += 1) {
    const decoded = decodeBar(body[index] ?? [], index + 2)
    if (Result.isFailure(decoded)) return fail(decoded.failure)
    bars.push(decoded.success)
  }
  if (bars.length === 0) return fail({ _tag: 'EmptyDevelopmentDataset' })
  const dates = bars.map((bar) => bar.sessionDate).sort()
  return Result.succeed({
    snapshotId,
    rawExportSha256: sha256(csv),
    firstSession: dates[0] as IsoDate,
    lastSession: dates.at(-1) as IsoDate,
    barCount: bars.length,
    bars,
  })
}
