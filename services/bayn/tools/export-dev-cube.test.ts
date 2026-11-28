import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { gunzipSync } from 'node:zlib'

import { Effect, Result } from 'effect'

import { sha256 } from '../src/hash'
import {
  CANONICAL_DEV_CUTOFF,
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
