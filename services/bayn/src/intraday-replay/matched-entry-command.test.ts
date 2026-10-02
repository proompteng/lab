import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Deferred, Effect, Exit, Fiber, FileSystem, Result } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'
import { canonicalHashV1, sha256 } from '../hash'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { makeJevObservation } from '../jev/observation'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { historicalRawArrivals } from '../testing/historical-streaming-fixture'
import { retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { compareArrivalPositions, arrivalPosition } from '../market-data/streaming/historical'
import { runMatchedCommand } from '../../tools/matched-entry-study'
import { matchedEntryDefinition, MatchedDataRole, runMatchedEntryStudy } from './matched-entry-study'
import { backtestSourcePartitions, type BacktestSourceManifest } from './source'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'

const fixture = () => {
  const base = nativeJevFixture()
  const dates = ['2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'] as const
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      dates.map((date) => ({ date, open: '09:30', close: '16:00' })),
      { start: dates[0] ?? '', end: dates[4] ?? '' },
    ),
  )
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(base.cut, { ...base.query, calendar }))
  const cut = base.cut
  const observation = Result.getOrThrow(
    makeJevObservation({
      cycleId: base.observation.payload.cycleId,
      authorityGenerationHash: base.observation.payload.authorityGenerationHash,
      protocol: base.protocol,
      portfolio: base.portfolio,
      snapshot,
    }),
  )
  const { decidedAt: _decidedAt, ...batch } = nativeJevDecisionEvidence({ ...base, snapshot, observation })
  const at = Date.parse(snapshot.manifest.observedAt)
  const events = [
    ...historicalRawArrivals(snapshot, at),
    ...[...cut.projection.features.values()].flat().map((f) => ({
      availableAtMs: at,
      record: { topic: f.topic, partition: f.partition, offset: f.offset, value: JSON.stringify(f.value) },
    })),
  ]
  const original = snapshot.latestQuotes['AAPL']
  if (original === undefined) throw new Error('Missing quote')
  let offset = events
    .filter((e) => e.record.topic === original.sourceTopic && e.record.partition === original.sourcePartition)
    .reduce((maximum, e) => (BigInt(e.record.offset) > maximum ? BigInt(e.record.offset) : maximum), 0n)
  for (let t = at + 100; t < at + 16 * 60_000; t += 5000) {
    const quote = {
      ...original,
      sourceOffset: String(++offset),
      eventAt: new Date(t).toISOString(),
      ingestedAt: new Date(t).toISOString(),
      bidSize: 1000,
      askSize: 1000,
    }
    events.push(...historicalRawArrivals({ bars: [], trades: [], quotes: [quote] }, t))
  }
  events.sort((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)))
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const positions = new Map<
    string,
    { topic: string; partition: number; startOffset: string; endOffsetExclusive: string }
  >()
  for (const event of events) {
    const key = `${event.record.topic}:${event.record.partition}`
    positions.set(key, {
      topic: event.record.topic,
      partition: event.record.partition,
      startOffset: positions.get(key)?.startOffset ?? event.record.offset,
      endOffsetExclusive: String(BigInt(event.record.offset) + 1n),
    })
  }
  const source: BacktestSourceManifest = {
    schemaVersion: 'bayn.backtest-source.v1',
    encoding: 'ndjson-gzip',
    transport: 'captured-kafka',
    dataSha256: sha256(gzipSync(body)),
    recordCount: events.length,
    coverageStartMs: Date.parse(calendar.sessions[0]?.openAt ?? ''),
    coverageEndMs: Date.parse(calendar.sessions[4]?.closeAt ?? ''),
    firstAvailableAtMs: events[0]?.availableAtMs ?? 0,
    lastAvailableAtMs: events.at(-1)?.availableAtMs ?? 0,
    origin: 'Synthetic native matched test capture',
    positions: [...positions.values()].sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition),
    universe: {
      universeId: base.protocol.universeId,
      universeSymbolHash: base.protocol.universeSymbolHash,
      symbols: base.protocol.universe,
      topics: { ...base.protocol.sourceTopics, features: 'torghut.market-features.v1' },
    },
    deliveryModel: {
      schemaVersion: 'bayn.supplied-arrival-times.v1',
      description: 'Synthetic observation-time capture',
      tieBreak: 'availability-topic-partition-offset',
    },
  }
  const completeSource = {
    ...source,
    positions: backtestSourcePartitions(source).map(
      ({ topic, partition }) =>
        positions.get(`${topic}:${partition}`) ?? { topic, partition, startOffset: '0', endOffsetExclusive: '0' },
    ),
  }
  const registration = {
    schemaVersion: 'bayn.matched-entry-registration.v1',
    definitionHash: canonicalHashV1(matchedEntryDefinition),
    sourceRevision: 'a'.repeat(40),
    protocolHash: canonicalHashV1(base.protocol),
    registeredAt: '2026-09-03T00:00:00.000Z',
    dataRole: MatchedDataRole.Development,
    sessionDates: dates,
    latencyMs: 100,
    executionAssumptionsHash: canonicalHashV1({
      latencyMs: 100,
      slippageBps: 0,
      availableLiquidityPpm: 1000000,
      feeMultiplierPpm: 1000000,
    }),
    latencyEvidenceHash: null,
    capacityEvidenceHash: null,
  }
  const input = {
    schemaVersion: 'bayn.matched-entry-input.v1',
    witnesses: [],
    study: {
      schemaVersion: 'bayn.jev-signal-study-input.v1',
      runId: 'e'.repeat(64),
      source: completeSource,
      assumptions: { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
      batches: [batch],
    },
    inventory: dates.map((sessionDate) => ({
      sessionDate,
      entryBatchIds: sessionDate === dates[0] ? [batch.batchPlan.batchId] : [],
      evidenceHash: null,
    })),
    costs: [{ batchId: batch.batchPlan.batchId, inference: null, sharedOperating: null }],
  }
  return { body, input, registration, receipt: retainedReplayCaptureFixture(completeSource) }
}

test('offline command reproduces native observations, prices shared lifecycle once, hashes report and refuses overwrite', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const checkout = yield* fs.makeTempDirectoryScoped()
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const git = (args: readonly string[]) =>
        ChildProcess.make('git', args, { cwd: checkout, stdin: 'ignore', stderr: 'ignore' })
      expect(Number(yield* spawner.exitCode(git(['init', '--quiet'])))).toBe(0)
      yield* fs.writeFileString(`${checkout}/source.ts`, 'export const value = 1\n')
      expect(Number(yield* spawner.exitCode(git(['add', 'source.ts'])))).toBe(0)
      expect(
        Number(
          yield* spawner.exitCode(
            git([
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.invalid',
              'commit',
              '--quiet',
              '-m',
              'fixture',
            ]),
          ),
        ),
      ).toBe(0)
      const sourceRevision = (yield* spawner.string(git(['rev-parse', 'HEAD']))).trim()
      let changeDuringEvaluation = false
      let revisionReads = 0
      const run = (args: readonly string[]) =>
        runMatchedCommand(args).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              if (command._tag !== 'StandardCommand' || command.command !== 'git')
                return Effect.die('Unexpected process in offline matched command')
              expect(command.options.cwd).toBe(fileURLToPath(new URL('../../../../', import.meta.url)))
              const changed =
                changeDuringEvaluation && command.args[0] === 'rev-parse' && ++revisionReads === 2
                  ? fs.writeFileString(`${checkout}/source.ts`, 'export const value = 4\n')
                  : Effect.void
              return changed.pipe(
                Effect.andThen(
                  spawner.spawn(ChildProcess.make('git', command.args, { ...command.options, cwd: checkout })),
                ),
              )
            }),
          ),
        )
      const arrivals = `${directory}/arrivals.gz`
      yield* fs.writeFile(arrivals, gzipSync(data.body))
      const inputPath = `${directory}/input.json`
      const registeredPath = `${directory}/registration.json`
      const receiptPath = `${directory}/receipt.json`
      const inputText = JSON.stringify(data.input)
      const registeredText = JSON.stringify({ ...data.registration, sourceRevision })
      const receiptText = JSON.stringify(data.receipt.value)
      yield* fs.writeFileString(inputPath, inputText)
      yield* fs.writeFileString(registeredPath, registeredText)
      yield* fs.writeFileString(receiptPath, receiptText)
      const outputPath = `${directory}/report.json`
      const args = [
        '--input',
        inputPath,
        '--input-sha256',
        sha256(inputText),
        '--registration',
        registeredPath,
        '--registration-sha256',
        sha256(registeredText),
        '--arrivals',
        arrivals,
        '--source-receipt',
        receiptPath,
        '--source-receipt-sha256',
        sha256(receiptText),
        '--output',
        outputPath,
      ]
      const mismatchedText = JSON.stringify({ ...data.registration, sourceRevision: '0'.repeat(40) })
      yield* fs.writeFileString(registeredPath, mismatchedText)
      expect(
        Result.isFailure(
          yield* run(args.map((v) => (v === sha256(registeredText) ? sha256(mismatchedText) : v))).pipe(Effect.result),
        ),
      ).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      yield* fs.writeFileString(registeredPath, registeredText)
      yield* fs.writeFileString(`${checkout}/source.ts`, 'export const value = 2\n')
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      expect(Number(yield* spawner.exitCode(git(['add', 'source.ts'])))).toBe(0)
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      expect(
        Number(yield* spawner.exitCode(git(['restore', '--source=HEAD', '--staged', '--worktree', 'source.ts']))),
      ).toBe(0)
      yield* fs.writeFileString(`${checkout}/untracked.ts`, 'export const value = 3\n')
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      yield* fs.remove(`${checkout}/untracked.ts`)
      changeDuringEvaluation = true
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(revisionReads).toBe(2)
      expect(yield* fs.exists(outputPath)).toBeFalse()
      changeDuringEvaluation = false
      expect(Number(yield* spawner.exitCode(git(['restore', 'source.ts'])))).toBe(0)
      yield* fs.rename(`${checkout}/.git`, `${checkout}/git-metadata`)
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      yield* fs.rename(`${checkout}/git-metadata`, `${checkout}/.git`)
      const report = yield* run(args)
      expect(report.pairs).toHaveLength(1)
      expect(report.pairs[0]?.jev).toEqual(report.pairs[0]?.momentum)
      expect(report.pairs[0]?.jev?.status).toBe('RESOLVED')
      expect(report.pairs[0]?.jev?.episodes[0]?.exitedAtMs).toBe(
        Date.parse(report.observations[0]?.decidedAt ?? '') + 100 + 15 * 60_000 + 100,
      )
      expect(report.summary.completion).toBe('INCOMPLETE')
      expect(report.summary.means.incrementalBudgetReturnBps).toBeNull()
      const { reportHash, ...material } = report
      expect(canonicalHashV1(material)).toBe(reportHash)
      expect(JSON.parse(yield* fs.readFileString(outputPath))).toEqual(report)
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(
        Result.isFailure(
          yield* run(args.map((v) => (v === sha256(inputText) ? '0'.repeat(64) : v))).pipe(Effect.result),
        ),
      ).toBeTrue()
      const late = {
        ...data.registration,
        dataRole: MatchedDataRole.Prospective,
        registeredAt: '2026-09-04T13:30:00.000Z',
      }
      expect(
        Result.isFailure(yield* runMatchedEntryStudy(data.input, late, arrivals, data.receipt).pipe(Effect.result)),
      ).toBeTrue()
      const changedFees = {
        ...data.input,
        study: { ...data.input.study, assumptions: { ...data.input.study.assumptions, feeMultiplierPpm: 2000000 } },
      }
      expect(
        Result.isFailure(
          yield* runMatchedEntryStudy(changedFees, data.registration, arrivals, data.receipt).pipe(Effect.result),
        ),
      ).toBeTrue()
      const duplicate = {
        ...data.input,
        study: { ...data.input.study, batches: [...data.input.study.batches, ...data.input.study.batches] },
      }
      expect(
        Result.isFailure(
          yield* runMatchedEntryStudy(duplicate, data.registration, arrivals, data.receipt).pipe(Effect.result),
        ),
      ).toBeTrue()
      const slowAssumptions = { ...data.input.study.assumptions, latencyMs: 20000 }
      const slow = { ...data.input, study: { ...data.input.study, assumptions: slowAssumptions } }
      const slowReport = yield* runMatchedEntryStudy(
        slow,
        { ...data.registration, latencyMs: 20000, executionAssumptionsHash: canonicalHashV1(slowAssumptions) },
        arrivals,
        data.receipt,
      )
      expect(slowReport.pairs[0]?.jev?.status).toBe('RESOLVED')
      const missingReport = yield* runMatchedEntryStudy(
        { ...data.input, inventory: data.input.inventory.slice(1) },
        data.registration,
        arrivals,
        data.receipt,
      )
      expect(missingReport.summary.completenessProblems).toContain('missing-session-inventory:2026-09-04')
      const mutated = {
        ...data.input,
        study: { ...data.input.study, source: { ...data.input.study.source, dataSha256: 'f'.repeat(64) } },
      }
      expect(
        Result.isFailure(
          yield* runMatchedEntryStudy(mutated, data.registration, arrivals, data.receipt).pipe(Effect.result),
        ),
      ).toBeTrue()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
}, 30_000)

test.each(['timeout', 'interruption', 'defect'] as const)(
  'checkout verification releases its process exactly once after %s and writes no report',
  async (termination) => {
    const data = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const inputText = JSON.stringify(data.input)
        const registrationText = JSON.stringify(data.registration)
        yield* fs.writeFileString(`${directory}/input.json`, inputText)
        yield* fs.writeFileString(`${directory}/registration.json`, registrationText)
        const started = yield* Deferred.make<void>()
        let finalized = 0
        const worker = yield* runMatchedCommand([
          '--input',
          `${directory}/input.json`,
          '--input-sha256',
          sha256(inputText),
          '--registration',
          `${directory}/registration.json`,
          '--registration-sha256',
          sha256(registrationText),
          '--arrivals',
          `${directory}/absent.gz`,
          '--source-receipt',
          `${directory}/absent.json`,
          '--source-receipt-sha256',
          '0'.repeat(64),
          '--output',
          `${directory}/report.json`,
        ]).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
                Effect.sync(() => {
                  finalized += 1
                }),
              ).pipe(Effect.andThen(termination === 'defect' ? Effect.die('synthetic Git defect') : Effect.never)),
            ),
          ),
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        if (termination === 'timeout') yield* TestClock.adjust('10 seconds')
        if (termination === 'interruption') yield* Fiber.interrupt(worker)
        expect(Exit.isFailure(yield* Fiber.await(worker))).toBeTrue()
        expect(finalized).toBe(1)
        expect(yield* fs.exists(`${directory}/report.json`)).toBeFalse()
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
    )
  },
)
