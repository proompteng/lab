import { NodeServices } from '@effect/platform-node'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigProvider, Effect, Exit, Sink, Stdio } from 'effect'
import { TestClock } from 'effect/testing'

import { sha256 } from './hash'
import {
  hybridCrashVwapModeConfig,
  parseHybridCrashVwapShadowArgs,
  runHybridCrashVwapShadowCommand,
} from './hybrid-crash-vwap-shadow-command'
import {
  HybridCrashVwapMode,
  hybridCrashVwapParams,
  hybridCrashVwapSessionBarsSchemaVersion,
} from './intraday-replay/crash-vwap-bounce'

const hash = 'a'.repeat(64)
const args = ['--input', 'bars.json', '--input-sha256', hash, '--output', 'record.json']

const withConfig = (values: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))

describe('hybrid crash-VWAP shadow command', () => {
  test('admits only exact input, input hash and new output arguments', () => {
    expect(parseHybridCrashVwapShadowArgs(['--help'])).toEqual({ _tag: 'Help' })
    expect(parseHybridCrashVwapShadowArgs(args)).toEqual({
      _tag: 'Run',
      inputPath: 'bars.json',
      inputHash: hash,
      outputPath: 'record.json',
    })
    for (const invalid of [
      [],
      args.slice(0, -1),
      [...args, '--mode', 'on'],
      [...args, '--input', 'other.json'],
      args.map((value) => (value === hash ? 'A'.repeat(64) : value)),
      args.map((value) => (value === 'record.json' ? '' : value)),
    ])
      expect(parseHybridCrashVwapShadowArgs(invalid)).toEqual({ _tag: 'Invalid' })
  })

  test('decodes the closed BAYN_HYBRID_CRASH_VWAP vocabulary and fails on anything else', async () => {
    const load = (values: Record<string, string>) =>
      Effect.runPromiseExit(hybridCrashVwapModeConfig.parse(ConfigProvider.fromUnknown(values)))
    expect(await load({})).toEqual(Exit.succeed(HybridCrashVwapMode.Off))
    expect(await load({ BAYN_HYBRID_CRASH_VWAP: 'off' })).toEqual(Exit.succeed(HybridCrashVwapMode.Off))
    expect(await load({ BAYN_HYBRID_CRASH_VWAP: 'shadow' })).toEqual(Exit.succeed(HybridCrashVwapMode.Shadow))
    // An empty variable is absent to the ConfigProvider, as for every other Bayn default.
    expect(await load({ BAYN_HYBRID_CRASH_VWAP: '' })).toEqual(Exit.succeed(HybridCrashVwapMode.Off))
    for (const value of ['on', 'Shadow', 'shadw', ' '])
      expect(Exit.isFailure(await load({ BAYN_HYBRID_CRASH_VWAP: value }))).toBe(true)
  })

  test('writes one clock-stamped shadow record and refuses to overwrite it', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.hybrid-crash-vwap-'))
    try {
      const open = hybridCrashVwapParams.rthOpenMinute
      const bars = [
        ...Array.from({ length: 35 }, (_, m) => ({ minuteOfDay: open + m, close: 100 })),
        { minuteOfDay: open + 35, close: 99 },
        { minuteOfDay: open + 36, close: 99.2 },
        { minuteOfDay: open + 37, close: 99.3 },
      ].map(({ minuteOfDay, close }) => ({
        symbol: 'CRDO',
        timestamp: new Date(Date.UTC(2026, 9, 7, 4, minuteOfDay)).toISOString(),
        minuteOfDay,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1000,
      }))
      const input = JSON.stringify({
        schemaVersion: hybridCrashVwapSessionBarsSchemaVersion,
        sessionDate: '2026-10-07',
        source: {
          provider: 'alpaca',
          feed: 'iex',
          datasetId: 'synthetic-test',
          calendarSource: 'synthetic-test',
          universe: ['CRDO'],
          completedThroughMinuteOfDay: open + 37,
          sessionCloseMinuteOfDay: 960,
        },
        barsBySymbol: { CRDO: bars },
      })
      const inputPath = join(directory, 'bars.json')
      const outputPath = join(directory, 'record.json')
      await writeFile(inputPath, input)
      const runArgs = ['--input', inputPath, '--input-sha256', sha256(input), '--output', outputPath]
      const stdout: string[] = []
      const run = (values: Record<string, string>, commandArgs = runArgs) =>
        Effect.runPromiseExit(
          Effect.gen(function* () {
            yield* TestClock.setTime(Date.parse('2026-10-07T20:05:00.000Z'))
            return yield* runHybridCrashVwapShadowCommand(commandArgs)
          }).pipe(
            Effect.provide(TestClock.layer()),
            Effect.provide(
              Stdio.layerTest({
                stdout: () =>
                  Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => stdout.push(String(chunk)))),
              }),
            ),
            Effect.provide(NodeServices.layer),
            withConfig(values),
          ),
        )

      expect(Exit.isSuccess(await run({}))).toBe(true)
      expect(JSON.parse(stdout.join(''))).toEqual({ mode: HybridCrashVwapMode.Off, outputPath: null })
      expect(await Bun.file(outputPath).exists()).toBe(false)

      stdout.length = 0
      expect(Exit.isSuccess(await run({ BAYN_HYBRID_CRASH_VWAP: 'shadow' }))).toBe(true)
      const record = JSON.parse(await readFile(outputPath, 'utf8'))
      expect(record).toMatchObject({
        inputSha256: sha256(input),
        sessionDate: '2026-10-07',
        evaluatedAt: '2026-10-07T20:05:00.000Z',
        candidates: [{ symbol: 'CRDO', signalMinuteOfDay: open + 35, entryMinuteOfDay: open + 37 }],
      })
      expect(JSON.parse(stdout.join(''))).toMatchObject({ mode: 'shadow', outputPath, candidates: 1 })
      const firstRecordHash = JSON.parse(stdout.join('')).recordHash

      // A changed entry-bar high does not change candidate fields, but must change durable input identity.
      const changedInput = JSON.stringify({
        ...JSON.parse(input),
        barsBySymbol: {
          CRDO: bars.map((bar) => (bar.minuteOfDay === open + 37 ? { ...bar, high: bar.high + 1 } : bar)),
        },
      })
      const changedInputPath = join(directory, 'changed-bars.json')
      const changedOutputPath = join(directory, 'changed-record.json')
      await writeFile(changedInputPath, changedInput)
      stdout.length = 0
      expect(
        Exit.isSuccess(
          await run({ BAYN_HYBRID_CRASH_VWAP: 'shadow' }, [
            '--input',
            changedInputPath,
            '--input-sha256',
            sha256(changedInput),
            '--output',
            changedOutputPath,
          ]),
        ),
      ).toBe(true)
      const changedRecord = JSON.parse(await readFile(changedOutputPath, 'utf8'))
      expect(changedRecord.candidates).toEqual(record.candidates)
      expect(changedRecord.inputSha256).toBe(sha256(changedInput))
      expect(changedRecord.inputSha256).not.toBe(record.inputSha256)
      expect(JSON.parse(stdout.join('')).recordHash).not.toBe(firstRecordHash)

      expect(Exit.isFailure(await run({ BAYN_HYBRID_CRASH_VWAP: 'shadow' }))).toBe(true)
      expect(Exit.isFailure(await run({ BAYN_HYBRID_CRASH_VWAP: 'on' }))).toBe(true)
      const tampered = runArgs.map((value) => (value === sha256(input) ? 'b'.repeat(64) : value))
      const freshOutput = tampered.map((value) => (value === outputPath ? join(directory, 'fresh.json') : value))
      expect(Exit.isFailure(await run({ BAYN_HYBRID_CRASH_VWAP: 'shadow' }, freshOutput))).toBe(true)
      expect(await Bun.file(join(directory, 'fresh.json')).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
