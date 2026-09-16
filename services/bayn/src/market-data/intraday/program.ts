import { Effect, type Result } from 'effect'
import { IntradaySnapshotFailure } from './model'
import { intradayArchivePageSize, type IntradayArchivePageCursor } from './queries'
import type { IntradayBarRow, IntradayQuoteRow, IntradayTradeRow } from './rows'
import { intradayInstantNanos } from './time'

type IntradayPageRow = IntradayBarRow | IntradayQuoteRow | IntradayTradeRow
type IntradayPageDecoder = (
  rows: readonly unknown[],
) => Result.Result<readonly IntradayPageRow[], IntradaySnapshotFailure>

const maximumIntradayArchivePages = 100
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const compareBigInt = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0)
const pageCursor = (row: IntradayPageRow): IntradayArchivePageCursor => ({
  eventAt: row.event_at,
  symbol: row.symbol,
  sourceTopic: row.source_topic,
  sourcePartition: Number(row.source_partition),
  sourceOffset: row.source_offset,
})
const comparePageCursors = (left: IntradayArchivePageCursor, right: IntradayArchivePageCursor): number =>
  compareBigInt(intradayInstantNanos(left.eventAt), intradayInstantNanos(right.eventAt)) ||
  compareText(left.symbol, right.symbol) ||
  compareText(left.sourceTopic, right.sourceTopic) ||
  left.sourcePartition - right.sourcePartition ||
  compareBigInt(BigInt(left.sourceOffset), BigInt(right.sourceOffset))

export const loadIntradayArchivePages = <E, R>(
  loadPage: (after?: IntradayArchivePageCursor) => Effect.Effect<readonly unknown[], E, R>,
  decodePage: IntradayPageDecoder,
  maximumRows: number,
  pageSize = intradayArchivePageSize,
): Effect.Effect<readonly unknown[], E | IntradaySnapshotFailure, R> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(maximumRows) || maximumRows < 1) {
      return yield* new IntradaySnapshotFailure({
        reason: 'rows',
        message: 'intraday archive row budget must be a positive safe integer',
        facts: { maximumRows },
      })
    }
    const rows: unknown[] = []
    let after: IntradayArchivePageCursor | undefined
    for (let page = 0; page < maximumIntradayArchivePages; page += 1) {
      const loaded = yield* loadPage(after)
      if (loaded.length > pageSize) {
        return yield* new IntradaySnapshotFailure({
          reason: 'rows',
          message: 'intraday archive page exceeded its fixed row limit',
          facts: { page, pageSize, rowCount: loaded.length },
        })
      }
      const decoded = yield* Effect.fromResult(decodePage(loaded))
      if (rows.length + loaded.length > maximumRows) {
        return yield* new IntradaySnapshotFailure({
          reason: 'rows',
          message: 'intraday archive snapshot exceeded its aggregate row budget',
          facts: { maximumRows, retainedRows: rows.length, incomingRows: loaded.length },
        })
      }
      rows.push(...loaded)
      if (loaded.length < pageSize) return Object.freeze(rows)
      const last = decoded.at(-1)
      if (last === undefined) {
        return yield* new IntradaySnapshotFailure({
          reason: 'rows',
          message: 'full intraday archive page has no canonical continuation row',
          facts: { page, pageSize },
        })
      }
      const next = pageCursor(last)
      if (after !== undefined && comparePageCursors(after, next) >= 0) {
        return yield* new IntradaySnapshotFailure({
          reason: 'ordering',
          message: 'intraday archive pagination did not advance its canonical cursor',
          facts: { page },
        })
      }
      after = next
    }
    return yield* new IntradaySnapshotFailure({
      reason: 'rows',
      message: 'intraday archive snapshot exceeded the bounded page budget',
      facts: { maximumPages: maximumIntradayArchivePages, pageSize },
    })
  })
