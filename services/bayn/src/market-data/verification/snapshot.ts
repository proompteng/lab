import { Result, pipe } from 'effect'

import type { MarketDataSnapshot, SnapshotRequest } from '../model'
import type { SignalBarRow, SignalManifestRow, SnapshotRows } from '../rows'
import { PublicationSchema, type DailyBar } from '../../types'
import { verifyCalendar } from './calendar'
import type { BarField, MarketDataVerificationError } from './errors'
import { canonicalHashResult, fail, requireCondition, validateAll, withoutSnapshot } from './shared'

const decimalNumber = (
  row: SignalBarRow,
  field: Extract<MarketDataVerificationError, { readonly _tag: 'DecimalInvalid' }>['field'],
  requirement: 'non-negative' | 'positive',
): Result.Result<number, MarketDataVerificationError> => {
  const value = row[field]
  const parsed = Number(value)
  return Number.isFinite(parsed) && (requirement === 'positive' ? parsed > 0 : parsed >= 0)
    ? Result.succeed(parsed)
    : fail({
        _tag: 'DecimalInvalid',
        field,
        requirement,
        value,
        symbol: row.symbol,
        sessionDate: row.session_date,
      })
}

const toDailyBar = (
  row: SignalBarRow,
  publicationSchemaVersion: PublicationSchema,
): Result.Result<DailyBar, MarketDataVerificationError> =>
  pipe(
    Result.all({
      open: decimalNumber(row, 'adjusted_open', 'positive'),
      high: decimalNumber(row, 'adjusted_high', 'positive'),
      low: decimalNumber(row, 'adjusted_low', 'positive'),
      close: decimalNumber(row, 'adjusted_close', 'positive'),
      volume: decimalNumber(row, 'adjusted_volume', 'non-negative'),
    }),
    Result.flatMap(({ close, high, low, open, volume }) =>
      pipe(
        requireCondition(low <= Math.min(open, close) && high >= Math.max(open, close) && low <= high, {
          _tag: 'OhlcInvalid',
          symbol: row.symbol,
          sessionDate: row.session_date,
          open,
          high,
          low,
          close,
        }),
        Result.map(
          (): DailyBar => ({
            symbol: row.symbol,
            sessionDate: row.session_date,
            open,
            high,
            low,
            close,
            volume,
            source: row.provider,
            sourceFeed: row.source_feed,
            adjustment: row.adjustment,
            publicationSchemaVersion,
          }),
        ),
      ),
    ),
  )

const barMismatch = (
  field: BarField,
  expected: unknown,
  observed: unknown,
  snapshotId: string,
  symbol: string | null,
  sessionDate: string | null,
): MarketDataVerificationError => ({
  _tag: 'BarFieldMismatch',
  field,
  expected,
  observed,
  snapshotId,
  symbol,
  sessionDate,
})

const validateBar = (
  bar: SignalBarRow,
  manifest: SignalManifestRow,
  request: SnapshotRequest,
  sessionDates: ReadonlySet<string>,
): Result.Result<void, MarketDataVerificationError> =>
  validateAll([
    requireCondition(
      bar.snapshot_id === request.snapshotId,
      barMismatch('snapshotId', request.snapshotId, bar.snapshot_id, request.snapshotId, bar.symbol, bar.session_date),
    ),
    requireCondition(
      bar.provider === manifest.provider &&
        bar.source_feed === manifest.source_feed &&
        bar.adjustment === manifest.adjustment,
      barMismatch(
        'provenance',
        { provider: manifest.provider, sourceFeed: manifest.source_feed, adjustment: manifest.adjustment },
        { provider: bar.provider, sourceFeed: bar.source_feed, adjustment: bar.adjustment },
        request.snapshotId,
        bar.symbol,
        bar.session_date,
      ),
    ),
    requireCondition(
      bar.publication_asof === manifest.publication_asof,
      barMismatch(
        'publicationAsOf',
        manifest.publication_asof,
        bar.publication_asof,
        request.snapshotId,
        bar.symbol,
        bar.session_date,
      ),
    ),
    requireCondition(sessionDates.has(bar.session_date), {
      _tag: 'BarOutsideCalendar',
      snapshotId: request.snapshotId,
      symbol: bar.symbol,
      sessionDate: bar.session_date,
    }),
  ])

export const verifyFinalizedSnapshot = (
  rows: SnapshotRows,
  request: SnapshotRequest,
): Result.Result<MarketDataSnapshot, MarketDataVerificationError> =>
  pipe(
    verifyCalendar(rows.sessions, rows.manifests, request),
    Result.flatMap((calendar) => {
      const { manifest, universe } = calendar.verifiedManifest
      const sessionDates = new Set(calendar.orderedSessions.map((session) => session.session_date))
      const orderedBars = [...rows.bars].sort((left, right) =>
        left.session_date === right.session_date
          ? left.symbol.localeCompare(right.symbol)
          : left.session_date.localeCompare(right.session_date),
      )
      const barKey = (bar: SignalBarRow): string => `${bar.symbol}\u001f${bar.session_date}`
      const duplicate = orderedBars.find(
        (bar, index) => index > 0 && barKey(orderedBars[index - 1] as SignalBarRow) === barKey(bar),
      )
      const barKeys = new Set(orderedBars.map(barKey))
      const actualSymbols = [...new Set(orderedBars.map((bar) => bar.symbol))].sort()
      const missingCells = calendar.orderedSessions.flatMap((session) =>
        universe
          .filter((symbol) => !barKeys.has(`${symbol}\u001f${session.session_date}`))
          .map((symbol) => ({ symbol, sessionDate: session.session_date })),
      )
      const boundedSessionDates = new Set(calendar.boundedSessions.map((session) => session.session_date))
      const boundedRows = orderedBars.filter((bar) => boundedSessionDates.has(bar.session_date))
      return pipe(
        canonicalHashResult('bars', request.snapshotId, orderedBars.map(withoutSnapshot)),
        Result.flatMap((barsContentHash) =>
          validateAll([
            ...orderedBars.map((bar) => validateBar(bar, manifest, request, sessionDates)),
            requireCondition(duplicate === undefined, {
              _tag: 'DuplicateBar',
              snapshotId: request.snapshotId,
              symbol: duplicate?.symbol ?? '',
              sessionDate: duplicate?.session_date ?? '',
            }),
            requireCondition(
              orderedBars.length === manifest.bar_count,
              barMismatch('barCount', manifest.bar_count, orderedBars.length, request.snapshotId, null, null),
            ),
            requireCondition(
              actualSymbols.join(',') === universe.join(','),
              barMismatch('universe', universe, actualSymbols, request.snapshotId, null, null),
            ),
            ...missingCells.map(({ sessionDate, symbol }) =>
              fail<void>({
                _tag: 'SnapshotCellMissing',
                snapshotId: request.snapshotId,
                symbol,
                sessionDate,
              }),
            ),
            requireCondition(
              barsContentHash === manifest.bars_content_hash,
              barMismatch(
                'barsContentHash',
                manifest.bars_content_hash,
                barsContentHash,
                request.snapshotId,
                null,
                null,
              ),
            ),
            requireCondition(
              boundedRows.length === calendar.inputManifest.rowCount,
              barMismatch(
                'boundedBarCount',
                calendar.inputManifest.rowCount,
                boundedRows.length,
                request.snapshotId,
                null,
                null,
              ),
            ),
          ]),
        ),
        Result.flatMap(() => Result.all(boundedRows.map((row) => toDailyBar(row, manifest.schema_version)))),
        Result.map((bars) => ({ bars, manifest: calendar.inputManifest })),
      )
    }),
  )
