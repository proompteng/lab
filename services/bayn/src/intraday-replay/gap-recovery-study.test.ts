import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Deferred, Effect, Fiber, FileSystem, Result, Stream } from 'effect'
import { canonicalHashV1, sha256 } from '../hash'
import {
  gapDecisionMs,
  gapFixture,
  gapPriorOpenMs,
  gapPriorCloseMs,
  gapSourceFixture,
} from './gap-recovery.test-support'
import { runGapRecoveryStudy } from './gap-recovery-study'
import { GapRecoveryDecision } from './gap-recovery'

const prepared = (missingBenchmark = false, wideBenchmark = false) => {
  const f = gapFixture(
    missingBenchmark
      ? { alter: (kind, inputs) => (kind === 'prior' ? inputs.filter((x) => x.symbol !== 'SPY') : inputs) }
      : wideBenchmark
        ? {
            alter: (kind, inputs) =>
              kind === 'current'
                ? inputs.map((x) =>
                    x.symbol === 'SPY' && x.channel === 'quotes' && x.eventAtMs === gapDecisionMs - 5_000
                      ? { ...x, bid: 200.1, ask: 200.3 }
                      : x,
                  )
                : inputs,
          }
        : {},
  )
  const previous = gapSourceFixture(f.previous, gapPriorOpenMs, gapPriorCloseMs)
  const current = gapSourceFixture(f.today, f.session.openMs, f.session.closeMs)
  return {
    previous,
    current,
    input: {
      schemaVersion: 'bayn.gap-recovery-study.v1',
      session: f.session.input,
      previousSource: previous.manifest,
      currentSource: current.manifest,
    },
  }
}

const local = (program: Effect.Effect<unknown, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))

test('two complete original-format source fixtures produce a deterministic decision without service configuration', () =>
  local(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const data = prepared()
      const previous = { arrivalsPath: `${dir}/previous.gz`, receipt: data.previous.receipt }
      const current = { arrivalsPath: `${dir}/current.gz`, receipt: data.current.receipt }
      yield* fs.writeFile(previous.arrivalsPath, data.previous.bytes)
      yield* fs.writeFile(current.arrivalsPath, data.current.bytes)
      const report = yield* runGapRecoveryStudy(data.input, previous, current)
      expect(report.decision.selectedSymbol).toBe('AAPL')
      expect(report.decision.status).toBe(GapRecoveryDecision.Selected)
      expect(report.previousReceipt.contentHash).toBe(data.previous.receiptHash)
      expect(report.currentReceipt.contentHash).toBe(data.current.receiptHash)
      const { reportHash, ...material } = report
      expect(canonicalHashV1(material)).toBe(reportHash)
      expect((yield* runGapRecoveryStudy(data.input, previous, current)).reportHash).toBe(reportHash)
      yield* fs.writeFile(current.arrivalsPath, Buffer.from('corrupt'))
      expect(Result.isFailure(yield* Effect.result(runGapRecoveryStudy(data.input, previous, current)))).toBeTrue()
    }).pipe(Effect.scoped),
  ))

test('refuses archive provenance and insufficient coverage before opening a source', () =>
  local(
    Effect.gen(function* () {
      const data = prepared()
      const previous = { arrivalsPath: '/not-a-source', receipt: data.previous.receipt }
      const current = { arrivalsPath: '/not-a-source', receipt: data.current.receipt }
      for (const input of [
        { ...data.input, previousSource: { ...data.previous.manifest, transport: 'archive-reconstruction' } },
        {
          ...data.input,
          currentSource: {
            ...data.current.manifest,
            coverageStartMs: Date.parse(data.input.session.calendar[1]?.date + 'T14:30:00Z'),
          },
        },
      ]) {
        const result = yield* Effect.result(runGapRecoveryStudy(input, previous, current))
        expect(Result.isFailure(result)).toBeTrue()
        if (Result.isFailure(result))
          expect(JSON.stringify(result.failure)).toContain('both original-capture intervals')
      }
    }),
  ))

test('interruption drains the scoped source and closes its file exactly once', () =>
  local(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const data = prepared()
      const started = yield* Deferred.make<void>()
      let opened = 0,
        finalized = 0
      const controlled: FileSystem.FileSystem = {
        ...fs,
        open: (path, options) =>
          Effect.gen(function* () {
            const file = yield* fs.open(path, options)
            opened++
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized++
              }),
            )
            return file
          }),
        stream: () =>
          Stream.concat(Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.drain), Stream.never),
      }
      const job = yield* runGapRecoveryStudy(
        data.input,
        { arrivalsPath: '/blocked-source', receipt: data.previous.receipt },
        { arrivalsPath: '/unread-source', receipt: data.current.receipt },
      ).pipe(Effect.provideService(FileSystem.FileSystem, controlled), Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(job)
      expect(opened).toBe(1)
      expect(finalized).toBe(1)
    }).pipe(Effect.scoped),
  ))

const command = new URL('../gap-recovery-command.ts', import.meta.url).pathname
test.each(['oversized', 'utf8', 'hash'] as const)(
  'command rejects %s input before acquiring arrival streams',
  async (kind) => {
    await local(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const bytes =
          kind === 'oversized'
            ? Buffer.alloc(512 * 1024 + 1, 32)
            : kind === 'utf8'
              ? Buffer.from([255])
              : Buffer.from('{}')
        yield* fs.writeFile(`${dir}/input`, bytes)
        const args = [
          'bun',
          command,
          '--input',
          `${dir}/input`,
          '--input-sha256',
          kind === 'hash' ? 'a'.repeat(64) : sha256(bytes),
          '--previous-arrivals',
          '/must-not-open',
          '--previous-receipt',
          '/must-not-open',
          '--previous-receipt-sha256',
          'a'.repeat(64),
          '--current-arrivals',
          '/must-not-open',
          '--current-receipt',
          '/must-not-open',
          '--current-receipt-sha256',
          'a'.repeat(64),
          '--output',
          `${dir}/report`,
        ]
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env['PATH'] } })),
          (p) => Effect.sync(() => p.kill()),
        )
        const [status, error] = yield* Effect.promise(() =>
          Promise.all([child.exited, new Response(child.stderr).text()]),
        )
        expect(status).toBe(1)
        expect(error).toContain(kind === 'oversized' ? '512 KiB' : kind === 'utf8' ? 'valid UTF-8' : 'hash differs')
        expect(yield* fs.exists(`${dir}/report`)).toBeFalse()
      }).pipe(Effect.scoped),
    )
  },
  10000,
)

test.each(['complete', 'missing', 'wide'] as const)(
  'command records original-receipt evidence and keeps benchmark failures explicit (%s)',
  async (kind) => {
    const incomplete = kind !== 'complete'
    await local(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const data = prepared(kind === 'missing', kind === 'wide')
        const inputText = JSON.stringify(data.input)
        for (const [name, bytes] of [
          ['previous.gz', data.previous.bytes],
          ['current.gz', data.current.bytes],
        ] as const)
          yield* fs.writeFile(`${dir}/${name}`, bytes)
        for (const [name, text] of [
          ['input.json', inputText],
          ['previous.json', data.previous.receiptText],
          ['current.json', data.current.receiptText],
        ] as const)
          yield* fs.writeFileString(`${dir}/${name}`, text)
        const args = [
          'bun',
          command,
          '--input',
          `${dir}/input.json`,
          '--input-sha256',
          sha256(inputText),
          '--previous-arrivals',
          `${dir}/previous.gz`,
          '--previous-receipt',
          `${dir}/previous.json`,
          '--previous-receipt-sha256',
          data.previous.receiptHash,
          '--current-arrivals',
          `${dir}/current.gz`,
          '--current-receipt',
          `${dir}/current.json`,
          '--current-receipt-sha256',
          data.current.receiptHash,
          '--output',
          `${dir}/report.json`,
        ]
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env['PATH'] } })),
          (process) => Effect.sync(() => process.kill()),
        )
        const [status, stdout, stderr] = yield* Effect.promise(() =>
          Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
        )
        expect(status).toBe(incomplete ? 1 : 0)
        expect(stdout).toContain(incomplete ? 'BENCHMARK_UNAVAILABLE' : 'SELECTED')
        if (incomplete) expect(stderr).toContain('inputs are incomplete')
        else expect(stderr).toBe('')
        const report = JSON.parse(yield* fs.readFileString(`${dir}/report.json`))
        const { reportHash, ...material } = report
        expect(canonicalHashV1(material)).toBe(reportHash)
        expect(report.decision.capitalAuthority).toBe('NONE')
        expect(report.decision.inputComplete).toBe(!incomplete)
        const retry = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })),
          (p) => Effect.sync(() => p.kill()),
        )
        const [retryStatus, retryError] = yield* Effect.promise(() =>
          Promise.all([retry.exited, new Response(retry.stderr).text()]),
        )
        expect(retryStatus).toBe(1)
        expect(retryError).toContain('refusing to overwrite')
      }).pipe(Effect.scoped),
    )
  },
  15000,
)
