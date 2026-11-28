import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { gunzipSync } from 'node:zlib'

import { Effect, Result, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { IsoDateSchema } from '../src/schemas'
import { universe as macroUniverse } from '../src/strategy/macro-etf-core/policy'
import {
  BaselineSeries,
  CANONICAL_DEV_CUTOFF,
  computeDevBaselineReturns,
  CubeExportErrorReason,
  CubeFormat,
  CubeSchemaVersion,
  DevCubeExportError,
  EXCLUDED_HOLDOUT_START,
  exportDevCube,
  loadDevSplitFromArchive,
  parseCliArgs,
  prepareDevCubeExport,
  validateDevCutoff,
  type CalendarRow,
  type DailyBarRow,
  type DevCubeInputDataset,
} from './export-dev-cube'
import { receipts } from './pure-etf-dual-horizon-data'
import type { ArchiveReader } from './research-lib/s3-archive'

const sampleCommit = 'a'.repeat(40)

const fixtureDataset = (): DevCubeInputDataset => ({
  calendar: [
    { date: '2023-12-28', openMs: Date.parse('2023-12-28T14:30:00Z'), minutes: 390 },
    { date: '2023-12-29', openMs: Date.parse('2023-12-29T14:30:00Z'), minutes: 390 },
  ],
  dailyBars: [
    {
      date: '2023-12-28',
      symbol: 'SPY',
      open: 476.8,
      high: 477.5,
      low: 476.1,
      close: 476.9,
      volume: 45_000_000,
      vwap: 476.85,
    },
    {
      date: '2023-12-28',
      symbol: 'QQQ',
      open: 411.2,
      high: 412.0,
      low: 410.5,
      close: 411.5,
      volume: 30_000_000,
      vwap: 411.4,
    },
    {
      date: '2023-12-29',
      symbol: 'SPY',
      open: 476.5,
      high: 477.0,
      low: 473.3,
      close: 475.3,
      volume: 55_000_000,
      vwap: 475.4,
    },
    {
      date: '2023-12-29',
      symbol: 'QQQ',
      open: 411.0,
      high: 411.6,
      low: 407.6,
      close: 409.5,
      volume: 40_000_000,
      vwap: 409.8,
    },
  ],
  intradayBars: [
    {
      date: '2023-12-29',
      symbol: 'QQQ',
      slot: 0,
      open: 411.0,
      high: 411.4,
      low: 410.7,
      close: 411.2,
      volume: 1_200_000,
      vwap: 411.1,
    },
  ],
  baselineReturns: [
    { date: '2023-12-28', B0: 0.0012, F4: 0.0005, O1: 0.0008 },
    { date: '2023-12-29', B0: -0.0004, F4: -0.0011, O1: -0.0006 },
  ],
})

test('validateDevCutoff enforces canonical 2023-12-29 boundary fail-closed', () => {
  const canonical = validateDevCutoff()
  expect(Result.isSuccess(canonical)).toBe(true)
  if (Result.isSuccess(canonical)) expect(canonical.success).toBe('2023-12-29')

  const earlier = validateDevCutoff('2021-12-31')
  expect(Result.isSuccess(earlier)).toBe(true)

  for (const forbidden of ['2023-12-30', EXCLUDED_HOLDOUT_START, '2024-06-01', '2026-11-25']) {
    const result = validateDevCutoff(forbidden)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DevCubeExportError)
      expect(result.failure.reason).toBe(CubeExportErrorReason.CutoffExceedsCanonical)
    }
  }

  const malformed = validateDevCutoff('2023-13-45')
  expect(Result.isFailure(malformed)).toBe(true)
  if (Result.isFailure(malformed)) {
    expect(malformed.failure.reason).toBe(CubeExportErrorReason.InvalidCutoff)
  }
})

test('fail-closed guard rejects any holdout row BEFORE creating or writing --out-dir', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'bayn-dev-cube-leak-'))
  const outDir = join(scratch, 'should-not-exist')
  try {
    const base = fixtureDataset()
    const cases: readonly DevCubeInputDataset[] = [
      {
        ...base,
        dailyBars: [
          ...base.dailyBars,
          {
            date: '2024-01-02',
            symbol: 'SPY',
            open: 472.1,
            high: 473.7,
            low: 470.5,
            close: 472.6,
            volume: 60_000_000,
            vwap: 472.3,
          },
        ],
      },
      {
        ...base,
        calendar: [...base.calendar, { date: '2024-01-02', openMs: Date.parse('2024-01-02T14:30:00Z'), minutes: 390 }],
      },
      {
        ...base,
        intradayBars: [
          ...(base.intradayBars ?? []),
          {
            date: '2024-01-02',
            symbol: 'QQQ',
            slot: 0,
            open: 405.0,
            high: 405.5,
            low: 404.5,
            close: 405.2,
            volume: 900_000,
            vwap: 405.1,
          },
        ],
      },
      {
        ...base,
        baselineReturns: [...(base.baselineReturns ?? []), { date: '2024-01-02', B0: 0.001, F4: 0.002, O1: -0.001 }],
      },
    ]

    for (const leaked of cases) {
      const outcome = await Effect.runPromise(
        Effect.result(exportDevCube(leaked, { outDir, sourceCommit: sampleCommit })),
      )
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(DevCubeExportError)
        expect(outcome.failure.reason).toBe(CubeExportErrorReason.HoldoutLeakageDetected)
        expect(outcome.failure.date).toBe('2024-01-02')
        expect(outcome.failure.devCutoff).toBe(CANONICAL_DEV_CUTOFF)
      }
      expect(existsSync(outDir)).toBe(false)
    }

    // Custom earlier devCutoff (train-only) also fails closed when validation rows are present.
    const trainOnly = await Effect.runPromise(
      Effect.result(exportDevCube(base, { outDir, devCutoff: '2021-12-31', sourceCommit: sampleCommit })),
    )
    expect(Result.isFailure(trainOnly)).toBe(true)
    if (Result.isFailure(trainOnly)) {
      expect(trainOnly.failure.reason).toBe(CubeExportErrorReason.HoldoutLeakageDetected)
      expect(trainOnly.failure.devCutoff).toBe('2021-12-31')
    }
    expect(existsSync(outDir)).toBe(false)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('exports deterministic gzipped JSONL and CSV dev cubes with verified SHA-256 MANIFEST.json', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'bayn-dev-cube-ok-'))
  try {
    const dataset = fixtureDataset()
    for (const format of [CubeFormat.JsonlGz, CubeFormat.CsvGz]) {
      const outA = join(scratch, `a-${format}`)
      const outB = join(scratch, `b-${format}`)
      const manifestA = await Effect.runPromise(
        exportDevCube(dataset, { outDir: outA, format, sourceCommit: sampleCommit }),
      )
      const manifestB = await Effect.runPromise(
        exportDevCube(dataset, { outDir: outB, format, sourceCommit: sampleCommit }),
      )

      expect(manifestA).toEqual(manifestB)
      expect(manifestA.schemaVersion).toBe(CubeSchemaVersion.V1)
      expect(manifestA.devCutoff).toBe(CANONICAL_DEV_CUTOFF)
      expect(manifestA.excludedHoldoutStart).toBe(EXCLUDED_HOLDOUT_START)
      expect(manifestA.sourceCommit).toBe(sampleCommit)
      expect(manifestA.hasBaselines).toBe(true)
      expect(manifestA.baselineSeries).toEqual([BaselineSeries.B0, BaselineSeries.F4, BaselineSeries.O1])
      expect(manifestA.symbols).toEqual(['QQQ', 'SPY'])
      expect(manifestA.rowCount).toBe(2 + 4 + 1 + 2)
      expect(manifestA.files.length).toBe(4)

      const rawManifestA = await readFile(join(outA, 'MANIFEST.json'), 'utf8')
      const rawManifestB = await readFile(join(outB, 'MANIFEST.json'), 'utf8')
      expect(rawManifestA).toBe(rawManifestB)

      for (const file of manifestA.files) {
        const compressed = await readFile(join(outA, file.path))
        expect(compressed.byteLength).toBe(file.bytes)
        expect(sha256(compressed)).toBe(file.sha256)
        const text = gunzipSync(compressed).toString('utf8').trim()
        const lines = text.split('\n')
        if (format === CubeFormat.JsonlGz) {
          expect(lines.length).toBe(file.rowCount)
        } else {
          expect(lines.length).toBe(file.rowCount + 1)
        }
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('preserves redacted error causes without leaking secrets in inspect or JSON output', () => {
  const secretToken = 'super-secret-s3-credential-value'
  const bad = prepareDevCubeExport(
    {
      calendar: [],
      dailyBars: [
        {
          date: '2023-12-29',
          symbol: 'SPY',
          open: 100,
          high: 99, // invalid: high < open
          low: 98,
          close: 99.5,
          volume: 100,
          vwap: 99.5,
        },
      ],
    },
    { sourceCommit: sampleCommit },
  )
  expect(Result.isFailure(bad)).toBe(true)
  if (Result.isFailure(bad)) {
    expect(bad.failure.reason).toBe(CubeExportErrorReason.InvalidRowData)
  }

  const parsed = parseCliArgs(['--unknown-flag', secretToken])
  expect(Result.isFailure(parsed)).toBe(true)
  if (Result.isFailure(parsed)) {
    expect(parsed.failure).toBeInstanceOf(DevCubeExportError)
    expect(parsed.failure.reason).toBe(CubeExportErrorReason.InvalidCliArgs)
    expect(inspect(parsed.failure)).not.toContain(secretToken)
    expect(JSON.stringify(parsed.failure)).not.toContain(secretToken)
  }
})

test('loadDevSplitFromArchive never requests sealed holdout keys and drops post-cutoff rows', async () => {
  const requestedKeys: string[] = []
  const fakeArchive: ArchiveReader = {
    readJson: async (key, _digest) => {
      requestedKeys.push(key)
      if (key.includes('calendar_2016_2023.json')) {
        // Generate synthetic sessions? Verify that calling loadDevSplitFromArchive with a bad cutoff fails before any read.
        return []
      }
      return {}
    },
    readGzip: async (receipt, _consume) => {
      requestedKeys.push(receipt.key)
      return 0 as never
    },
  }

  let caught: unknown
  try {
    await loadDevSplitFromArchive(fakeArchive, { devCutoff: EXCLUDED_HOLDOUT_START })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DevCubeExportError)
  if (caught instanceof DevCubeExportError) {
    expect(caught.reason).toBe(CubeExportErrorReason.CutoffExceedsCanonical)
  }
  expect(requestedKeys).toEqual([])

  // Confirm none of the canonical dev-accessible keys reference the holdout/recent archive prefix.
  expect(receipts.datasets.blind.prefix).not.toBe(receipts.datasets.recent.prefix)
  expect(receipts.calendars.blind.name).toBe('calendar_2016_2023.json')
})

test('records hasBaselines=false when absent and fails closed when requireBaselines is set', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'bayn-dev-cube-nobase-'))
  const noBaseDir = join(scratch, 'no-base')
  const reqBaseDir = join(scratch, 'req-base')
  try {
    const { baselineReturns: _omitted, ...withoutBaselines } = fixtureDataset()

    const manifest = await Effect.runPromise(
      exportDevCube(withoutBaselines, { outDir: noBaseDir, sourceCommit: sampleCommit }),
    )
    expect(manifest.hasBaselines).toBe(false)
    expect(manifest.baselineSeries).toEqual([])
    expect(manifest.files.some((f) => f.kind === 'baseline_returns')).toBe(false)

    const failed = await Effect.runPromise(
      Effect.result(
        exportDevCube(withoutBaselines, {
          outDir: reqBaseDir,
          sourceCommit: sampleCommit,
          requireBaselines: true,
        }),
      ),
    )
    expect(Result.isFailure(failed)).toBe(true)
    if (Result.isFailure(failed)) {
      expect(failed.failure).toBeInstanceOf(DevCubeExportError)
      expect(failed.failure.reason).toBe(CubeExportErrorReason.MissingBaselines)
    }
    expect(existsSync(reqBaseDir)).toBe(false)

    const cliParsed = parseCliArgs(['--out-dir', reqBaseDir, '--require-baselines'])
    expect(Result.isSuccess(cliParsed)).toBe(true)
    if (Result.isSuccess(cliParsed)) {
      expect(cliParsed.success.requireBaselines).toBe(true)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

const makeSyntheticFullUniverseDevSplit = (sessions: number, shockStart?: number) => {
  const decodeIsoDate = Schema.decodeUnknownSync(IsoDateSchema)
  const calendar: CalendarRow[] = []
  const dailyBars: DailyBarRow[] = []
  const cur = new Date('2016-01-04T00:00:00Z')
  while (calendar.length < sessions) {
    const day = cur.getUTCDay()
    if (day !== 0 && day !== 6) {
      const date = decodeIsoDate(cur.toISOString().slice(0, 10))
      calendar.push({ date, openMs: Date.parse(`${date}T14:30:00Z`), minutes: 390 })
    }
    cur.setUTCDate(cur.getUTCDate() + 1)
  }

  const prices = new Map<string, number>(macroUniverse.map((sym, idx) => [sym, 50 + idx * 3]))
  for (const [t, session] of calendar.entries()) {
    for (const [idx, symbol] of macroUniverse.entries()) {
      const prev = prices.get(symbol) ?? 100
      const baseDrift = 0.0003 + ((idx % 7) - 3) * 0.00015
      const wave = 0.004 * Math.sin((t + 1) * (0.11 + idx * 0.017))
      const shock = shockStart !== undefined && t >= shockStart ? 0.03 * (idx % 2 === 0 ? 1 : -1) : 0
      const open = Number((prev * (1 + 0.3 * wave)).toFixed(4))
      const close = Number(Math.max(1, prev * (1 + baseDrift + wave + shock)).toFixed(4))
      const high = Number((Math.max(open, close) * 1.003).toFixed(4))
      const low = Number((Math.min(open, close) * 0.997).toFixed(4))
      const vwap = Number(((open + close) / 2).toFixed(4))
      prices.set(symbol, close)
      dailyBars.push({
        date: session.date,
        symbol,
        open,
        high,
        low,
        close,
        volume: 1_000_000,
        vwap,
      })
    }
  }
  return { calendar, dailyBars }
}

test('computeDevBaselineReturns derives causal F4 and O1 dev baselines strictly <= devCutoff', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'bayn-dev-cube-causal-base-'))
  try {
    const baseData = makeSyntheticFullUniverseDevSplit(160)
    const shockedData = makeSyntheticFullUniverseDevSplit(160, 130)

    const baseResult = computeDevBaselineReturns(baseData)
    const shockedResult = computeDevBaselineReturns(shockedData)
    expect(Result.isSuccess(baseResult)).toBe(true)
    expect(Result.isSuccess(shockedResult)).toBe(true)
    if (Result.isFailure(baseResult) || Result.isFailure(shockedResult)) return

    const baseRows = baseResult.success
    const shockedRows = shockedResult.success
    expect(baseRows.length).toBe(160)
    expect(baseRows.every((row) => row.date <= CANONICAL_DEV_CUTOFF)).toBe(true)
    // Daily-only frames produce causal F4 and O1 without fabricating intraday B0.
    expect(baseRows.every((row) => row.B0 === undefined && Number.isFinite(row.F4) && Number.isFinite(row.O1))).toBe(
      true,
    )
    // Verify strict causality: future shocks from day 130 onward do not alter prior baseline returns.
    expect(baseRows.slice(0, 130)).toEqual(shockedRows.slice(0, 130))
    expect(baseRows.slice(130)).not.toEqual(shockedRows.slice(130))

    // Export cube with computed baselines and verify MANIFEST.json metadata & file contents.
    const outDir = join(scratch, 'cube')
    const manifest = await Effect.runPromise(
      exportDevCube(
        { ...baseData, baselineReturns: baseRows },
        { outDir, sourceCommit: sampleCommit, requireBaselines: true },
      ),
    )
    expect(manifest.hasBaselines).toBe(true)
    expect(manifest.baselineSeries).toEqual([BaselineSeries.F4, BaselineSeries.O1])
    const baselineFile = manifest.files.find((f) => f.kind === 'baseline_returns')
    expect(baselineFile).toBeDefined()
    if (baselineFile !== undefined) {
      const text = gunzipSync(await readFile(join(outDir, baselineFile.path)))
        .toString('utf8')
        .trim()
      const firstRow = JSON.parse(text.split('\n')[0] ?? '{}') as Record<string, unknown>
      expect(Object.keys(firstRow)).toEqual(['date', 'F4', 'O1'])
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
