import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'

import { NodeRuntime } from '@effect/platform-node'
import { Console, Data, Effect, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../src/hash'
import {
  type IsoDate,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
} from '../src/schemas'
import {
  type Etf,
  parameters as macroParameters,
  Profile,
  universe as macroUniverse,
} from '../src/strategy/macro-etf-core/policy'
import { closeSnapshotSchema, replayMacroEtfCoreSignals } from '../src/strategy/macro-etf-core/signals'
import {
  baskets,
  capital as noiseCapital,
  createReplay,
  type Day,
  netAt,
  prepare,
  selectionCost as noiseSelectionCost,
  splits as noiseSplits,
  type Symbol as NoiseSymbol,
  type Trial as NoiseTrial,
} from './noise-area-study-replay'
import { receipts, tapeReceipt } from './pure-etf-dual-horizon-data'
import { noiseRosters } from './pure-etf-dual-horizon-noise'
import { normalizeResearchCalendar, requireCalendarCoverage, type Session } from './research-lib/calendar'
import {
  type ArchiveReader,
  countArchiveLines,
  decodeArchiveJson,
  readGzipLines,
  S3ArchiveError,
  withS3Archive,
} from './research-lib/s3-archive'
import type { Bar as DailyBar, DailyFrame } from './research/macro-etf-core-dual-horizon-data'
import { wave5dTargets } from './research/macro-etf-core-wave5d'
import { type DailySession, replayDaily, ShareSizing } from './three-account-capital-core'

export const canonicalDevSplits = Object.freeze({
  train: noiseSplits.train,
  validation: noiseSplits.validation,
} as const)

export const CANONICAL_DEV_CUTOFF = noiseSplits.validation.last
export const EXCLUDED_HOLDOUT_START = noiseSplits.holdout.first

export enum CubeSchemaVersion {
  V1 = 'bayn.colab-dev-cube.v1',
}

export enum CubeFormat {
  JsonlGz = 'jsonl.gz',
  CsvGz = 'csv.gz',
}

export enum CubeFileKind {
  Calendar = 'calendar',
  DailyBars = 'daily_bars',
  IntradayBars = 'intraday_bars',
  BaselineReturns = 'baseline_returns',
}

export enum BaselineSeries {
  B0 = 'B0',
  F4 = 'F4',
  O1 = 'O1',
}

export enum CubeExportErrorReason {
  InvalidCliArgs = 'invalid-cli-args',
  InvalidCutoff = 'invalid-cutoff',
  CutoffExceedsCanonical = 'cutoff-exceeds-canonical',
  HoldoutLeakageDetected = 'holdout-leakage-detected',
  InvalidRowData = 'invalid-row-data',
  DuplicateRow = 'duplicate-row',
  EmptyDataset = 'empty-dataset',
  MissingBaselines = 'missing-baselines',
  ArchiveReadFailed = 'archive-read-failed',
  WriteFailed = 'write-failed',
  GitRevisionFailed = 'git-revision-failed',
}

export class DevCubeExportError extends Data.TaggedError('DevCubeExportError')<{
  readonly reason: CubeExportErrorReason
  readonly message: string
  readonly date?: string
  readonly devCutoff?: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

export const CubeSchemaVersionSchema = Schema.Enum(CubeSchemaVersion)
export const CubeFormatSchema = Schema.Enum(CubeFormat)
export const CubeFileKindSchema = Schema.Enum(CubeFileKind)
export const BaselineSeriesSchema = Schema.Enum(BaselineSeries)
export const CubeExportErrorReasonSchema = Schema.Enum(CubeExportErrorReason)

const DailyBarRowSchema = Schema.Struct({
  date: IsoDateSchema,
  symbol: StrictNonEmptyStringSchema,
  open: PositiveFiniteSchema,
  high: PositiveFiniteSchema,
  low: PositiveFiniteSchema,
  close: PositiveFiniteSchema,
  volume: NonNegativeIntegerSchema,
  vwap: PositiveFiniteSchema,
})

const IntradayBarRowSchema = Schema.Struct({
  date: IsoDateSchema,
  symbol: StrictNonEmptyStringSchema,
  slot: NonNegativeIntegerSchema,
  open: PositiveFiniteSchema,
  high: PositiveFiniteSchema,
  low: PositiveFiniteSchema,
  close: PositiveFiniteSchema,
  volume: NonNegativeIntegerSchema,
  vwap: PositiveFiniteSchema,
})

const BaselineReturnRowSchema = Schema.Struct({
  date: IsoDateSchema,
  B0: Schema.optionalKey(Schema.Finite),
  F4: Schema.optionalKey(Schema.Finite),
  O1: Schema.optionalKey(Schema.Finite),
})

const CalendarRowSchema = Schema.Struct({
  date: IsoDateSchema,
  openMs: Schema.Int,
  minutes: Schema.Int.check(Schema.isGreaterThan(0)),
})

export type DailyBarRow = typeof DailyBarRowSchema.Type
export type IntradayBarRow = typeof IntradayBarRowSchema.Type
export type BaselineReturnRow = typeof BaselineReturnRowSchema.Type
export type CalendarRow = typeof CalendarRowSchema.Type

const ManifestFileSchema = Schema.Struct({
  kind: CubeFileKindSchema,
  path: StrictNonEmptyStringSchema,
  sha256: Sha256Schema,
  bytes: NonNegativeIntegerSchema,
  rowCount: NonNegativeIntegerSchema,
})

const SplitWindowSchema = Schema.Struct({
  first: IsoDateSchema,
  last: IsoDateSchema,
  count: NonNegativeIntegerSchema,
})

export const DevCubeManifestSchema = Schema.Struct({
  schemaVersion: CubeSchemaVersionSchema,
  format: CubeFormatSchema,
  devCutoff: IsoDateSchema,
  canonicalDevCutoff: IsoDateSchema,
  excludedHoldoutStart: IsoDateSchema,
  sourceCommit: StrictNonEmptyStringSchema,
  hasBaselines: Schema.Boolean,
  baselineSeries: Schema.Array(BaselineSeriesSchema),
  splits: Schema.Struct({
    train: SplitWindowSchema,
    validation: SplitWindowSchema,
  }),
  dateRange: Schema.Struct({
    first: IsoDateSchema,
    last: IsoDateSchema,
  }),
  symbols: Schema.Array(StrictNonEmptyStringSchema),
  rowCount: NonNegativeIntegerSchema,
  files: Schema.Array(ManifestFileSchema),
})

export type DevCubeManifestFile = typeof ManifestFileSchema.Type
export type DevCubeManifest = typeof DevCubeManifestSchema.Type

export interface DevCubeInputDataset {
  readonly calendar: readonly CalendarRow[]
  readonly dailyBars: readonly DailyBarRow[]
  readonly intradayBars?: readonly IntradayBarRow[]
  readonly baselineReturns?: readonly BaselineReturnRow[]
}

export interface ExportDevCubeOptions {
  readonly outDir: string
  readonly devCutoff?: string
  readonly format?: CubeFormat
  readonly sourceCommit: string
  readonly requireBaselines?: boolean
}

const decodeIsoDate = Schema.decodeUnknownResult(IsoDateSchema)
const decodeFormat = Schema.decodeUnknownResult(CubeFormatSchema)
const decodeCalendarRow = Schema.decodeUnknownResult(CalendarRowSchema)
const decodeDailyBarRow = Schema.decodeUnknownResult(DailyBarRowSchema)
const decodeIntradayBarRow = Schema.decodeUnknownResult(IntradayBarRowSchema)
const decodeBaselineRow = Schema.decodeUnknownResult(BaselineReturnRowSchema)
const decodeManifest = Schema.decodeUnknownResult(DevCubeManifestSchema)

const exportError = (
  reason: CubeExportErrorReason,
  message: string,
  extra?: { readonly date?: string; readonly devCutoff?: string; readonly cause?: unknown },
) =>
  new DevCubeExportError({
    reason,
    message,
    ...(extra?.date === undefined ? {} : { date: extra.date }),
    ...(extra?.devCutoff === undefined ? {} : { devCutoff: extra.devCutoff }),
    ...(extra?.cause === undefined ? {} : { cause: Redacted.make(extra.cause) }),
  })

/** Validate and resolve the requested devCutoff against Bayn's canonical development split boundary. */
export const validateDevCutoff = (requested?: string): Result.Result<string, DevCubeExportError> => {
  const candidate = requested ?? CANONICAL_DEV_CUTOFF
  const parsed = decodeIsoDate(candidate)
  if (Result.isFailure(parsed)) {
    return Result.fail(
      exportError(CubeExportErrorReason.InvalidCutoff, `Invalid --dev-cutoff ISO date: ${candidate}`, {
        devCutoff: candidate,
        cause: parsed.failure,
      }),
    )
  }
  const devCutoff = parsed.success
  if (devCutoff > CANONICAL_DEV_CUTOFF || devCutoff >= EXCLUDED_HOLDOUT_START) {
    return Result.fail(
      exportError(
        CubeExportErrorReason.CutoffExceedsCanonical,
        `Requested devCutoff (${devCutoff}) exceeds Bayn canonical development cutoff (${CANONICAL_DEV_CUTOFF}); sealed holdout starts ${EXCLUDED_HOLDOUT_START}`,
        { devCutoff },
      ),
    )
  }
  return Result.succeed(devCutoff)
}

const assertNotPastCutoff = (
  date: string,
  devCutoff: string,
  label: string,
): Result.Result<void, DevCubeExportError> => {
  if (date > devCutoff || date >= EXCLUDED_HOLDOUT_START) {
    return Result.fail(
      exportError(
        CubeExportErrorReason.HoldoutLeakageDetected,
        `Refusing to export ${label} on ${date}: exceeds devCutoff (${devCutoff}) or enters sealed holdout (${EXCLUDED_HOLDOUT_START})`,
        { date, devCutoff },
      ),
    )
  }
  return Result.succeed(undefined)
}

const validateOhlc = (
  open: number,
  high: number,
  low: number,
  close: number,
  label: string,
): Result.Result<void, DevCubeExportError> => {
  if (high < Math.max(open, close) || low > Math.min(open, close)) {
    return Result.fail(exportError(CubeExportErrorReason.InvalidRowData, `Invalid OHLC bounds for ${label}`))
  }
  return Result.succeed(undefined)
}

const csvEscape = (value: string | number): string => {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const encodeRows = <T extends Record<string, string | number | undefined>>(
  rows: readonly T[],
  columns: readonly (keyof T & string)[],
  format: CubeFormat,
): Uint8Array => {
  let payload: string
  if (format === CubeFormat.JsonlGz) {
    payload =
      rows
        .map((row) => {
          const ordered: Record<string, string | number> = {}
          for (const col of columns) {
            const val = row[col]
            if (val !== undefined) ordered[col] = val
          }
          return JSON.stringify(ordered)
        })
        .join('\n') + (rows.length > 0 ? '\n' : '')
  } else {
    const header = columns.join(',')
    const lines = rows.map((row) =>
      columns
        .map((col) => {
          const val = row[col]
          return val === undefined ? '' : csvEscape(val)
        })
        .join(','),
    )
    payload = [header, ...lines].join('\n') + '\n'
  }
  // Pin mtime/OS-independent gzip output at level 9 for deterministic SHA-256 receipts.
  const compressed = gzipSync(Buffer.from(payload, 'utf8'), { level: 9 })
  // Zero gzip header mtime (bytes 4..7) and OS byte (byte 9) for cross-platform determinism.
  compressed[4] = 0
  compressed[5] = 0
  compressed[6] = 0
  compressed[7] = 0
  compressed[9] = 3
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength)
}

interface PreparedFile {
  readonly kind: CubeFileKind
  readonly path: string
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly rowCount: number
}

interface PreparedExport {
  readonly manifest: DevCubeManifest
  readonly manifestBytes: Uint8Array
  readonly files: readonly PreparedFile[]
}

/**
 * Pure validation and deterministic serialization of a dev-split-only cube.
 * Enforces all fail-closed invariants BEFORE any filesystem writes occur.
 */
export const prepareDevCubeExport = (
  dataset: DevCubeInputDataset,
  options: Omit<ExportDevCubeOptions, 'outDir'>,
): Result.Result<PreparedExport, DevCubeExportError> => {
  const cutoffResult = validateDevCutoff(options.devCutoff)
  if (Result.isFailure(cutoffResult)) return Result.fail(cutoffResult.failure)
  const devCutoff = cutoffResult.success
  const format = options.format ?? CubeFormat.JsonlGz

  if (options.sourceCommit.trim().length === 0) {
    return Result.fail(exportError(CubeExportErrorReason.InvalidCliArgs, 'sourceCommit must be non-empty'))
  }
  if (dataset.dailyBars.length === 0) {
    return Result.fail(exportError(CubeExportErrorReason.EmptyDataset, 'Cannot export a dev cube with zero daily bars'))
  }

  // 1. Validate calendar rows fail-closed
  const calendarRows: CalendarRow[] = []
  const seenCalendarDates = new Set<string>()
  for (const raw of dataset.calendar) {
    const parsed = decodeCalendarRow(raw)
    if (Result.isFailure(parsed)) {
      return Result.fail(
        exportError(CubeExportErrorReason.InvalidRowData, 'Invalid calendar row', { cause: parsed.failure }),
      )
    }
    const row = parsed.success
    const guard = assertNotPastCutoff(row.date, devCutoff, 'calendar session')
    if (Result.isFailure(guard)) return Result.fail(guard.failure)
    if (seenCalendarDates.has(row.date)) {
      return Result.fail(
        exportError(CubeExportErrorReason.DuplicateRow, `Duplicate calendar session: ${row.date}`, { date: row.date }),
      )
    }
    seenCalendarDates.add(row.date)
    calendarRows.push(row)
  }
  calendarRows.sort((a, b) => a.date.localeCompare(b.date))

  // 2. Validate daily bar rows fail-closed
  const dailyRows: DailyBarRow[] = []
  const seenDaily = new Set<string>()
  const symbolSet = new Set<string>()
  for (const raw of dataset.dailyBars) {
    const parsed = decodeDailyBarRow(raw)
    if (Result.isFailure(parsed)) {
      return Result.fail(
        exportError(CubeExportErrorReason.InvalidRowData, 'Invalid daily bar row', { cause: parsed.failure }),
      )
    }
    const row = parsed.success
    const guard = assertNotPastCutoff(row.date, devCutoff, `daily bar (${row.symbol})`)
    if (Result.isFailure(guard)) return Result.fail(guard.failure)
    const ohlcGuard = validateOhlc(row.open, row.high, row.low, row.close, `daily ${row.symbol} ${row.date}`)
    if (Result.isFailure(ohlcGuard)) return Result.fail(ohlcGuard.failure)
    const key = `${row.date}\t${row.symbol}`
    if (seenDaily.has(key)) {
      return Result.fail(
        exportError(CubeExportErrorReason.DuplicateRow, `Duplicate daily bar: ${row.symbol} ${row.date}`, {
          date: row.date,
        }),
      )
    }
    seenDaily.add(key)
    symbolSet.add(row.symbol)
    dailyRows.push(row)
  }
  dailyRows.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol))

  // 3. Validate optional intraday bar rows fail-closed
  const intradayRows: IntradayBarRow[] = []
  if (dataset.intradayBars !== undefined && dataset.intradayBars.length > 0) {
    const seenIntraday = new Set<string>()
    for (const raw of dataset.intradayBars) {
      const parsed = decodeIntradayBarRow(raw)
      if (Result.isFailure(parsed)) {
        return Result.fail(
          exportError(CubeExportErrorReason.InvalidRowData, 'Invalid intraday bar row', { cause: parsed.failure }),
        )
      }
      const row = parsed.success
      const guard = assertNotPastCutoff(row.date, devCutoff, `intraday bar (${row.symbol} slot ${row.slot})`)
      if (Result.isFailure(guard)) return Result.fail(guard.failure)
      const ohlcGuard = validateOhlc(
        row.open,
        row.high,
        row.low,
        row.close,
        `intraday ${row.symbol} ${row.date}#${row.slot}`,
      )
      if (Result.isFailure(ohlcGuard)) return Result.fail(ohlcGuard.failure)
      const key = `${row.date}\t${row.symbol}\t${row.slot}`
      if (seenIntraday.has(key)) {
        return Result.fail(
          exportError(
            CubeExportErrorReason.DuplicateRow,
            `Duplicate intraday bar: ${row.symbol} ${row.date} slot ${row.slot}`,
            { date: row.date },
          ),
        )
      }
      seenIntraday.add(key)
      symbolSet.add(row.symbol)
      intradayRows.push(row)
    }
    intradayRows.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol) || a.slot - b.slot)
  }

  // 4. Validate optional baseline return rows fail-closed
  const baselineRows: BaselineReturnRow[] = []
  const seenBaselineSeries = new Set<BaselineSeries>()
  if (dataset.baselineReturns !== undefined && dataset.baselineReturns.length > 0) {
    const seenBaseline = new Set<string>()
    for (const raw of dataset.baselineReturns) {
      const parsed = decodeBaselineRow(raw)
      if (Result.isFailure(parsed)) {
        return Result.fail(
          exportError(CubeExportErrorReason.InvalidRowData, 'Invalid baseline return row', { cause: parsed.failure }),
        )
      }
      const row = parsed.success
      const guard = assertNotPastCutoff(row.date, devCutoff, 'baseline return row')
      if (Result.isFailure(guard)) return Result.fail(guard.failure)
      if (seenBaseline.has(row.date)) {
        return Result.fail(
          exportError(CubeExportErrorReason.DuplicateRow, `Duplicate baseline return row: ${row.date}`, {
            date: row.date,
          }),
        )
      }
      let rowHasAnySeries = false
      for (const series of [BaselineSeries.B0, BaselineSeries.F4, BaselineSeries.O1] as const) {
        if (row[series] !== undefined) {
          seenBaselineSeries.add(series)
          rowHasAnySeries = true
        }
      }
      if (!rowHasAnySeries) {
        return Result.fail(
          exportError(
            CubeExportErrorReason.InvalidRowData,
            `Baseline return row on ${row.date} has no populated baseline series`,
            { date: row.date },
          ),
        )
      }
      seenBaseline.add(row.date)
      baselineRows.push(row)
    }
    baselineRows.sort((a, b) => a.date.localeCompare(b.date))
  }

  const baselineSeries = ([BaselineSeries.B0, BaselineSeries.F4, BaselineSeries.O1] as const).filter((series) =>
    seenBaselineSeries.has(series),
  )
  const hasBaselines = baselineRows.length > 0 && baselineSeries.length > 0
  if (options.requireBaselines === true && !hasBaselines) {
    return Result.fail(
      exportError(
        CubeExportErrorReason.MissingBaselines,
        'Baselines are required (--require-baselines), but no baseline return series were provided or derived',
      ),
    )
  }

  const ext = format
  const files: PreparedFile[] = []
  const pushFile = <T extends Record<string, string | number | undefined>>(
    kind: CubeFileKind,
    rows: readonly T[],
    columns: readonly (keyof T & string)[],
  ) => {
    const path = `${kind}.${ext}`
    const bytes = encodeRows(rows, columns, format)
    files.push({
      kind,
      path,
      bytes,
      sha256: sha256(bytes),
      rowCount: rows.length,
    })
  }

  if (calendarRows.length > 0) {
    pushFile(CubeFileKind.Calendar, calendarRows, ['date', 'openMs', 'minutes'])
  }
  pushFile(CubeFileKind.DailyBars, dailyRows, ['date', 'symbol', 'open', 'high', 'low', 'close', 'volume', 'vwap'])
  if (intradayRows.length > 0) {
    pushFile(CubeFileKind.IntradayBars, intradayRows, [
      'date',
      'symbol',
      'slot',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'vwap',
    ])
  }
  if (hasBaselines) {
    pushFile(CubeFileKind.BaselineReturns, baselineRows, ['date', ...baselineSeries])
  }

  const firstRow = dailyRows[0]
  const lastRow = dailyRows[dailyRows.length - 1]
  if (firstRow === undefined || lastRow === undefined) {
    return Result.fail(
      exportError(CubeExportErrorReason.EmptyDataset, 'Cannot derive date range from empty daily bars'),
    )
  }

  const manifestCandidate = {
    schemaVersion: CubeSchemaVersion.V1,
    format,
    devCutoff,
    canonicalDevCutoff: CANONICAL_DEV_CUTOFF,
    excludedHoldoutStart: EXCLUDED_HOLDOUT_START,
    sourceCommit: options.sourceCommit,
    hasBaselines,
    baselineSeries,
    splits: {
      train: canonicalDevSplits.train,
      validation: canonicalDevSplits.validation,
    },
    dateRange: {
      first: firstRow.date,
      last: lastRow.date,
    },
    symbols: [...symbolSet].toSorted(),
    rowCount: files.reduce((total, file) => total + file.rowCount, 0),
    files: files.map((file) => ({
      kind: file.kind,
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes.byteLength,
      rowCount: file.rowCount,
    })),
  }

  const verifiedManifest = decodeManifest(manifestCandidate)
  if (Result.isFailure(verifiedManifest)) {
    return Result.fail(
      exportError(CubeExportErrorReason.InvalidRowData, 'Prepared manifest failed schema validation', {
        cause: verifiedManifest.failure,
      }),
    )
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify(verifiedManifest.success, null, 2) + '\n')
  return Result.succeed({
    manifest: verifiedManifest.success,
    manifestBytes,
    files,
  })
}

/**
 * Validate fail-closed and write the dev-split cube + MANIFEST.json atomically into options.outDir.
 * No directory or file is created if any validation or holdout guard fails.
 */
export const exportDevCube = (dataset: DevCubeInputDataset, options: ExportDevCubeOptions) =>
  Effect.gen(function* () {
    const prepared = yield* Effect.fromResult(prepareDevCubeExport(dataset, options))
    yield* Effect.tryPromise({
      try: async (signal) => {
        signal.throwIfAborted()
        await mkdir(options.outDir, { recursive: true })
        for (const file of prepared.files) {
          signal.throwIfAborted()
          await writeFile(join(options.outDir, file.path), file.bytes, { signal })
        }
        signal.throwIfAborted()
        await writeFile(join(options.outDir, 'MANIFEST.json'), prepared.manifestBytes, { signal })
      },
      catch: (cause) =>
        exportError(CubeExportErrorReason.WriteFailed, `Failed to write dev cube to ${options.outDir}`, { cause }),
    })
    return prepared.manifest
  })

const dailySymbols = new Set<string>(macroUniverse)
const intradaySymbols = new Set<string>(noiseRosters.I1)
const optionalMacroSymbols = new Set<Etf>(macroParameters.optionalCandidates)
const requiredMacroSymbols = macroUniverse.filter((symbol) => !optionalMacroSymbols.has(symbol))
const BASELINE_INITIAL_USD = 100_000
const BASELINE_ONE_WAY_BPS = 5 as const
const b0BaselineTrial: NoiseTrial = {
  id: 'B0/30/1.4/opposite_band/inverse_vol_parity',
  basket: 'B0',
  minutes: 30,
  band: 1.4,
  exit: 'opposite_band',
  sizing: 'inverse_vol_parity',
}
const b0Symbols = new Set<string>(baskets.B0)

const equitiesToSimpleReturns = (equities: readonly number[], initialUsd: number): readonly number[] =>
  equities.map((equity, i) => {
    const prior = i === 0 ? initialUsd : (equities[i - 1] ?? initialUsd)
    return equity / prior - 1
  })

/**
 * Compute causal development-split baseline daily returns (F4, O1, and B0 when intraday
 * bars are present) strictly from the already-cutoff-filtered dev frames (<= devCutoff).
 */
export const computeDevBaselineReturns = (
  dataset: Pick<DevCubeInputDataset, 'calendar' | 'dailyBars' | 'intradayBars'>,
): Result.Result<readonly BaselineReturnRow[], DevCubeExportError> => {
  if (dataset.calendar.length < 2 || dataset.dailyBars.length === 0) {
    return Result.succeed([])
  }

  const sortedCalendar = [...dataset.calendar].toSorted((a, b) => a.date.localeCompare(b.date))
  const barsByDate = new Map<string, Map<Etf, DailyBar>>()
  for (const session of sortedCalendar) {
    barsByDate.set(session.date, new Map<Etf, DailyBar>())
  }
  for (const bar of dataset.dailyBars) {
    if (!dailySymbols.has(bar.symbol)) continue
    const bucket = barsByDate.get(bar.date)
    if (bucket === undefined) continue
    bucket.set(bar.symbol as Etf, { open: bar.open, high: bar.high, low: bar.low, close: bar.close })
  }

  const frames: DailyFrame[] = sortedCalendar.map((session) => ({
    date: session.date,
    openAt: session.openMs,
    closeAt: session.openMs + session.minutes * 60_000,
    bars: barsByDate.get(session.date) ?? new Map<Etf, DailyBar>(),
  }))

  const hasFullMacroUniverse = frames.every((frame) => requiredMacroSymbols.every((symbol) => frame.bars.has(symbol)))

  let f4Returns: readonly number[] | undefined
  if (
    hasFullMacroUniverse &&
    frames.length >= macroParameters.warmup + 1 &&
    frames[0]?.date === macroParameters.epoch
  ) {
    const lastFrame = frames[frames.length - 1]
    if (lastFrame !== undefined) {
      const snapshotCalendar = frames.map(({ date, openAt, closeAt }) => ({ date, openAt, closeAt }))
      const snapshot = {
        schema: closeSnapshotSchema,
        datasetVersion: 'bayn-dev-cube-causal-replay',
        adjustment: 'all' as const,
        calendar: snapshotCalendar,
        bars: frames
          .slice(0, -1)
          .map(({ date, closeAt, bars }) =>
            [...bars].map(([symbol, bar]) => ({ date, symbol, availableAt: closeAt, ...bar })),
          ),
      }
      const snapshotHash = canonicalHashV1Result(snapshot)
      if (Result.isFailure(snapshotHash)) {
        return Result.fail(
          exportError(CubeExportErrorReason.InvalidRowData, 'Failed to hash dev close snapshot for F4 baseline', {
            cause: snapshotHash.failure,
          }),
        )
      }
      const f4Signals = replayMacroEtfCoreSignals(
        { schema: 'bayn.macro-etf-core-policy.v1', profile: Profile.F4 },
        { asOf: lastFrame.openAt, snapshot, snapshotHash: snapshotHash.success },
      )
      if (Result.isFailure(f4Signals)) {
        return Result.fail(
          exportError(CubeExportErrorReason.InvalidRowData, 'Failed to replay causal F4 dev baseline', {
            cause: f4Signals.failure,
          }),
        )
      }
      const f4Targets = new Map(f4Signals.success.map(({ executionDate, weights }) => [executionDate, weights]))
      const f4Sessions: DailySession[] = frames.map(({ date, bars }) => ({
        date,
        bars,
        f4: f4Targets.get(date),
        o1: undefined,
      }))
      const f4Equities = Result.try({
        try: () => replayDaily(f4Sessions, BASELINE_INITIAL_USD, 'f4', ShareSizing.Fractional, BASELINE_ONE_WAY_BPS),
        catch: (cause) =>
          exportError(CubeExportErrorReason.InvalidRowData, 'Failed to simulate causal F4 dev baseline', { cause }),
      })
      if (Result.isFailure(f4Equities)) return Result.fail(f4Equities.failure)
      f4Returns = equitiesToSimpleReturns(f4Equities.success, BASELINE_INITIAL_USD)
    }
  }

  let o1Returns: readonly number[] | undefined
  if (hasFullMacroUniverse && frames.length >= 2) {
    const o1Equities = Result.try({
      try: () => {
        const o1 = wave5dTargets(frames)
        const o1Sessions: DailySession[] = frames.map(({ date, bars }, i) => ({
          date,
          bars,
          f4: undefined,
          o1: i === 0 ? undefined : o1[i - 1],
        }))
        return replayDaily(o1Sessions, BASELINE_INITIAL_USD, 'o1', ShareSizing.Fractional, BASELINE_ONE_WAY_BPS)
      },
      catch: (cause) =>
        exportError(CubeExportErrorReason.InvalidRowData, 'Failed to simulate causal O1 dev baseline', { cause }),
    })
    if (Result.isFailure(o1Equities)) return Result.fail(o1Equities.failure)
    o1Returns = equitiesToSimpleReturns(o1Equities.success, BASELINE_INITIAL_USD)
  }

  let b0Returns: ReadonlyMap<string, number> | undefined
  if (dataset.intradayBars !== undefined && dataset.intradayBars.length > 0 && sortedCalendar.length >= 15) {
    const intradayByDate = new Map<
      string,
      {
        readonly slots: number
        readonly bars: Map<
          NoiseSymbol,
          ({ open: number; high: number; low: number; close: number; volume: number; vwap: number } | undefined)[]
        >
      }
    >()
    for (const session of sortedCalendar) {
      intradayByDate.set(session.date, {
        slots: Math.trunc(session.minutes / 5),
        bars: new Map(),
      })
    }
    for (const bar of dataset.intradayBars) {
      if (!b0Symbols.has(bar.symbol)) continue
      const entry = intradayByDate.get(bar.date)
      if (entry === undefined || bar.slot < 0 || bar.slot >= entry.slots) continue
      const sym = bar.symbol as NoiseSymbol
      let series = entry.bars.get(sym)
      if (series === undefined) {
        series = Array.from({ length: entry.slots })
        entry.bars.set(sym, series)
      }
      series[bar.slot] = {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        vwap: bar.vwap,
      }
    }

    const hasAllB0Sessions = sortedCalendar.every((session) => {
      const entry = intradayByDate.get(session.date)
      return entry !== undefined && baskets.B0.every((symbol) => entry.bars.has(symbol))
    })
    if (hasAllB0Sessions) {
      const days: Day[] = sortedCalendar.map((session) => {
        const entry = intradayByDate.get(session.date)
        return {
          date: session.date,
          slots: entry?.slots ?? Math.trunc(session.minutes / 5),
          bars: entry?.bars ?? new Map(),
        }
      })
      const b0Replay = Result.try({
        try: () => {
          const out = new Map<string, number>()
          for (const day of prepare(days, baskets.B0)) {
            const ledger = createReplay(day)(b0BaselineTrial)
            const net = netAt(ledger, noiseSelectionCost)
            if (net === null || !Number.isFinite(net)) {
              throw new Error(`Unresolved causal B0 intraday exit on ${day.date}`)
            }
            out.set(day.date, net / noiseCapital)
          }
          return out
        },
        catch: (cause) =>
          exportError(CubeExportErrorReason.InvalidRowData, 'Failed to simulate causal B0 dev baseline', { cause }),
      })
      if (Result.isFailure(b0Replay)) return Result.fail(b0Replay.failure)
      b0Returns = b0Replay.success
    }
  }

  if (f4Returns === undefined && o1Returns === undefined && b0Returns === undefined) {
    return Result.succeed([])
  }

  const rows: BaselineReturnRow[] = []
  for (const [i, session] of sortedCalendar.entries()) {
    const b0 = b0Returns?.get(session.date)
    const f4 = f4Returns?.[i]
    const o1 = o1Returns?.[i]
    if (
      (b0 !== undefined && !Number.isFinite(b0)) ||
      (f4 !== undefined && !Number.isFinite(f4)) ||
      (o1 !== undefined && !Number.isFinite(o1))
    ) {
      return Result.fail(
        exportError(CubeExportErrorReason.InvalidRowData, `Non-finite computed baseline return on ${session.date}`, {
          date: session.date,
        }),
      )
    }
    rows.push({
      date: session.date,
      ...(b0 === undefined ? {} : { B0: b0 }),
      ...(f4 === undefined ? {} : { F4: f4 }),
      ...(o1 === undefined ? {} : { O1: o1 }),
    })
  }
  return Result.succeed(rows)
}
const dailyStampPattern = /^\d{4}-\d{2}-\d{2}T0[45]:00:00(?:\.\d+)?Z$/
const intradayStampPattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00(?:\.0+)?(?:Z|\+00:00)$/

const parseBarValues = (fields: readonly string[], vwapIndex: number, label: string) => {
  const open = Number(fields[2])
  const high = Number(fields[3])
  const low = Number(fields[4])
  const close = Number(fields[5])
  const volume = Number(fields[6])
  const vwap = Number(fields[vwapIndex])
  if (
    ![open, high, low, close, volume, vwap].every((v) => Number.isFinite(v) && v > 0) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    !Number.isSafeInteger(volume)
  ) {
    throw exportError(CubeExportErrorReason.InvalidRowData, `Invalid OHLCV bar in archive: ${label}`)
  }
  return { open, high, low, close, volume, vwap }
}

const decodeIsoDateOrThrow = (date: string, label: string): IsoDate => {
  const parsed = decodeIsoDate(date)
  if (Result.isFailure(parsed)) {
    throw exportError(CubeExportErrorReason.InvalidRowData, `Invalid ISO date for ${label}: ${date}`, {
      date,
      cause: parsed.failure,
    })
  }
  return parsed.success
}

/**
 * Load ONLY development-split calendar and bars from Bayn's content-addressed archive reader.
 * Never opens sealed holdout manifests, calendars, or intraday archives.
 */
export const loadDevSplitFromArchive = async (
  archive: ArchiveReader,
  options: { readonly devCutoff?: string; readonly includeIntraday?: boolean } = {},
): Promise<DevCubeInputDataset> => {
  const cutoffResult = validateDevCutoff(options.devCutoff)
  if (Result.isFailure(cutoffResult)) throw cutoffResult.failure
  const devCutoff = cutoffResult.success

  const { datasets, calendars } = receipts
  // Authenticate dev-accessible upstream manifests only; never touch datasets.recent or calendars.recent.
  await archive.readJson(`${datasets.daily.prefix}/MANIFEST.json`, datasets.daily.manifestSha256)
  await archive.readJson(`${datasets.macro.prefix}/MANIFEST.json`, datasets.macro.manifestSha256)
  if (options.includeIntraday === true) {
    await archive.readJson(`${datasets.blind.prefix}/MANIFEST.json`, datasets.blind.manifestSha256)
  }

  const blindCalendarResponse = await archive.readJson(
    `${calendars.blind.prefix}/${calendars.blind.name}`,
    calendars.blind.sha256,
  )
  const fullDevCalendar: readonly Session[] = requireCalendarCoverage(
    normalizeResearchCalendar({
      query: { start: canonicalDevSplits.train.first, end: CANONICAL_DEV_CUTOFF },
      response: blindCalendarResponse,
    }),
    canonicalDevSplits.train.first,
    CANONICAL_DEV_CUTOFF,
    canonicalDevSplits.train.count + canonicalDevSplits.validation.count,
  )
  const devCalendar = fullDevCalendar
    .filter(({ date }) => date <= devCutoff)
    .map((session) => ({
      date: decodeIsoDateOrThrow(session.date, 'calendar session'),
      openMs: session.openMs,
      minutes: session.minutes,
    }))
  const allowedDates = new Map(devCalendar.map((session) => [session.date as string, session]))

  const dailyBars: DailyBarRow[] = []
  for (const kind of ['daily', 'macro'] as const) {
    const receipt = datasets[kind]
    const seen = new Map<string, string>()
    const rows = await archive.readGzip(
      tapeReceipt(receipt),
      countArchiveLines((line) => {
        const tab = line.indexOf('\t')
        if (tab <= 0) return
        const symbol = line.slice(0, tab)
        if (!dailySymbols.has(symbol)) return
        const fields = line.split('\t')
        const stamp = fields[1]
        if (fields.length !== 8 || stamp === undefined || !dailyStampPattern.test(stamp)) {
          throw exportError(CubeExportErrorReason.InvalidRowData, `Malformed ${kind} archive row: ${symbol}`)
        }
        const date = stamp.slice(0, 10)
        // Upstream 10yr daily archive includes holdout rows; drop strictly beyond devCutoff before buffering.
        if (date > devCutoff) return
        const session = allowedDates.get(date)
        if (session === undefined) {
          throw exportError(CubeExportErrorReason.InvalidRowData, `Off-calendar ${kind} bar: ${symbol} ${date}`, {
            date,
          })
        }
        if ((kind === 'macro') !== (symbol === 'DIA' || symbol === 'UUP')) {
          throw exportError(CubeExportErrorReason.InvalidRowData, `Unexpected symbol ${symbol} in ${kind} archive`)
        }
        const prevDate = seen.get(symbol)
        if (prevDate !== undefined && date <= prevDate) {
          throw exportError(
            CubeExportErrorReason.DuplicateRow,
            `Unordered or duplicate ${kind} bar: ${symbol} ${date}`,
            {
              date,
            },
          )
        }
        seen.set(symbol, date)
        const parsed = parseBarValues(fields, 7, `${symbol} ${date}`)
        dailyBars.push({ date: session.date, symbol, ...parsed })
      }),
    )
    if (rows !== receipt.rows) {
      throw exportError(
        CubeExportErrorReason.ArchiveReadFailed,
        `Archive row count mismatch for ${kind}: got ${rows}, expected ${receipt.rows}`,
      )
    }
  }

  const intradayBars: IntradayBarRow[] = []
  if (options.includeIntraday === true) {
    const receipt = datasets.blind
    const lastSeen = new Map<string, number>()
    let headerRows = 0
    const rows = await archive.readGzip(
      tapeReceipt(receipt),
      countArchiveLines((line, index) => {
        if (index === 0 && line === 'symbol\tt\to\th\tl\tc\tv\tn\tvw') {
          headerRows++
          return
        }
        const tab = line.indexOf('\t')
        if (tab <= 0) return
        const symbol = line.slice(0, tab)
        if (!intradaySymbols.has(symbol)) return
        const fields = line.split('\t')
        const stamp = fields[1]
        if (fields.length !== 9 || stamp === undefined || !intradayStampPattern.test(stamp)) {
          throw exportError(CubeExportErrorReason.InvalidRowData, `Malformed blind intraday bar: ${symbol}`)
        }
        const date = stamp.slice(0, 10)
        if (date > devCutoff) return
        const session = allowedDates.get(date)
        const time = Date.parse(stamp)
        if (session === undefined || !Number.isFinite(time) || time <= (lastSeen.get(symbol) ?? -Infinity)) {
          throw exportError(CubeExportErrorReason.InvalidRowData, `Invalid intraday timestamp: ${symbol} ${stamp}`, {
            date,
          })
        }
        lastSeen.set(symbol, time)
        const slots = session.minutes / 5
        const slot = (time - session.openMs) / 300_000
        if (!Number.isInteger(slot)) {
          throw exportError(CubeExportErrorReason.InvalidRowData, `Off-grid 5m bar: ${symbol} ${stamp}`, { date })
        }
        if (slot < 0 || slot >= slots) return
        const parsed = parseBarValues(fields, 8, `${symbol} ${stamp}`)
        intradayBars.push({ date: session.date, symbol, slot, ...parsed })
      }),
    )
    if (rows - headerRows !== receipt.rows) {
      throw exportError(
        CubeExportErrorReason.ArchiveReadFailed,
        `Archive row count mismatch for blind 5m: got ${rows - headerRows}, expected ${receipt.rows}`,
      )
    }
  }

  const baseDataset = {
    calendar: devCalendar,
    dailyBars,
    ...(intradayBars.length > 0 ? { intradayBars } : {}),
  }
  const computedBaselines = computeDevBaselineReturns(baseDataset)
  if (Result.isFailure(computedBaselines)) throw computedBaselines.failure

  return {
    ...baseDataset,
    ...(computedBaselines.success.length > 0 ? { baselineReturns: computedBaselines.success } : {}),
  }
}

export const loadDevSplitFromDirectory = (
  directory: string,
  options: { readonly devCutoff?: string; readonly includeIntraday?: boolean } = {},
) =>
  Effect.tryPromise({
    try: (signal) =>
      loadDevSplitFromArchive(
        {
          readJson: async (key, digest) => decodeArchiveJson(await Bun.file(join(directory, key)).bytes(), key, digest),
          readGzip: (receipt, consume) =>
            readGzipLines(Bun.file(join(directory, receipt.key)).stream(), receipt, signal, consume),
        },
        options,
      ),
    catch: (cause) =>
      cause instanceof DevCubeExportError
        ? cause
        : exportError(CubeExportErrorReason.ArchiveReadFailed, `Unable to read local archive mirror at ${directory}`, {
            cause,
          }),
  })

export const loadDevSplitFromS3 = (options: { readonly devCutoff?: string; readonly includeIntraday?: boolean } = {}) =>
  withS3Archive((archive) => loadDevSplitFromArchive(archive, options)).pipe(
    Effect.mapError(
      (cause): DevCubeExportError =>
        cause instanceof S3ArchiveError
          ? exportError(CubeExportErrorReason.ArchiveReadFailed, cause.message, { cause })
          : exportError(CubeExportErrorReason.ArchiveReadFailed, 'Unable to read S3 dev-split archive', { cause }),
    ),
  )

const repoRoot = new URL('../../../', import.meta.url)

const resolveSourceCommit = (explicit?: string) =>
  Effect.try({
    try: () => {
      if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim()
      const run = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot.pathname, stderr: 'pipe' })
      if (run.exitCode !== 0) {
        throw exportError(
          CubeExportErrorReason.GitRevisionFailed,
          `Unable to resolve git HEAD: ${run.stderr.toString().trim()}`,
        )
      }
      return run.stdout.toString().trim()
    },
    catch: (cause) =>
      cause instanceof DevCubeExportError
        ? cause
        : exportError(CubeExportErrorReason.GitRevisionFailed, 'Failed to resolve source commit SHA', { cause }),
  })

interface CliArgs {
  readonly outDir: string
  readonly devCutoff?: string
  readonly format: CubeFormat
  readonly mirrorDir?: string
  readonly includeIntraday: boolean
  readonly requireBaselines: boolean
  readonly sourceCommit?: string
}

export const parseCliArgs = (argv: readonly string[]): Result.Result<CliArgs, DevCubeExportError> => {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          'out-dir': { type: 'string' },
          'dev-cutoff': { type: 'string' },
          format: { type: 'string' },
          'mirror-dir': { type: 'string' },
          'include-intraday': { type: 'boolean', default: false },
          'require-baselines': { type: 'boolean', default: false },
          'source-commit': { type: 'string' },
        },
        strict: true,
      }),
    catch: (cause) =>
      exportError(
        CubeExportErrorReason.InvalidCliArgs,
        'Usage: bun tools/export-dev-cube.ts --out-dir <dir> [--dev-cutoff YYYY-MM-DD] [--format jsonl.gz|csv.gz] [--mirror-dir <dir>] [--include-intraday] [--require-baselines] [--source-commit <sha>]',
        { cause },
      ),
  })
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  const values = parsed.success.values
  const outDir = values['out-dir']
  if (outDir === undefined || outDir.trim().length === 0) {
    return Result.fail(exportError(CubeExportErrorReason.InvalidCliArgs, 'Missing required --out-dir argument'))
  }
  const formatRaw = values.format ?? CubeFormat.JsonlGz
  const formatResult = decodeFormat(formatRaw)
  if (Result.isFailure(formatResult)) {
    return Result.fail(
      exportError(CubeExportErrorReason.InvalidCliArgs, `Unsupported --format: ${formatRaw} (use jsonl.gz or csv.gz)`, {
        cause: formatResult.failure,
      }),
    )
  }
  const cutoffResult = validateDevCutoff(values['dev-cutoff'])
  if (Result.isFailure(cutoffResult)) return Result.fail(cutoffResult.failure)

  return Result.succeed({
    outDir,
    devCutoff: cutoffResult.success,
    format: formatResult.success,
    ...(values['mirror-dir'] === undefined ? {} : { mirrorDir: values['mirror-dir'] }),
    includeIntraday: values['include-intraday'] === true,
    requireBaselines: values['require-baselines'] === true,
    ...(values['source-commit'] === undefined ? {} : { sourceCommit: values['source-commit'] }),
  })
}

const main = Effect.gen(function* () {
  const cli = yield* Effect.fromResult(parseCliArgs(Bun.argv.slice(2)))
  const sourceCommit = yield* resolveSourceCommit(cli.sourceCommit)
  const loadOptions = {
    ...(cli.devCutoff === undefined ? {} : { devCutoff: cli.devCutoff }),
    includeIntraday: cli.includeIntraday,
  }
  const dataset =
    cli.mirrorDir !== undefined
      ? yield* loadDevSplitFromDirectory(cli.mirrorDir, loadOptions)
      : yield* loadDevSplitFromS3(loadOptions)
  const manifest = yield* exportDevCube(dataset, {
    outDir: cli.outDir,
    ...(cli.devCutoff === undefined ? {} : { devCutoff: cli.devCutoff }),
    format: cli.format,
    sourceCommit,
    requireBaselines: cli.requireBaselines,
  })
  yield* Console.log(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      outDir: cli.outDir,
      devCutoff: manifest.devCutoff,
      excludedHoldoutStart: manifest.excludedHoldoutStart,
      hasBaselines: manifest.hasBaselines,
      baselineSeries: manifest.baselineSeries,
      rowCount: manifest.rowCount,
      files: manifest.files.length,
    }),
  )
})

if (import.meta.main) NodeRuntime.runMain(main)
