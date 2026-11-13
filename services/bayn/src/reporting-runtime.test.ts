import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, Logger, References, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { requireReportingRuntime, withReportResourceMeasurement } from './reporting-runtime'

test.each([{}, { BAYN_REPORTING_ALLOWED: 'true' }])(
  'allows explicit reporting runtimes and local tools: %j',
  async (values) => {
    const result = await Effect.runPromise(
      Effect.result(requireReportingRuntime).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
      ),
    )
    expect(Result.isSuccess(result)).toBe(true)
  },
)

test.each(['false', 'invalid'])(
  'rejects controller or malformed reporting configuration before evidence access: %s',
  async (value) => {
    let entered = false
    const result = await Effect.runPromise(
      Effect.result(
        requireReportingRuntime.pipe(
          Effect.andThen(
            Effect.sync(() => {
              entered = true
            }),
          ),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ BAYN_REPORTING_ALLOWED: value }),
          ),
        ),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(entered).toBe(false)
    if (value === 'false') expect(result).toMatchObject({ failure: { _tag: 'ReportingRuntimeForbidden' } })
  },
)

test.each(['success', 'failure', 'defect'] as const)(
  'records real process peak memory once on %s without changing the result',
  async (outcome) => {
    const logs: Readonly<Record<string, unknown>>[] = []
    const report =
      outcome === 'success'
        ? Effect.succeed('report')
        : outcome === 'failure'
          ? Effect.fail('source failure')
          : Effect.die('source defect')
    const exit = await Effect.runPromiseExit(
      withReportResourceMeasurement('test-report', report).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ fiber }) => logs.push(fiber.getRef(References.CurrentLogAnnotations)))]),
        ),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(outcome === 'success')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      command: 'test-report',
      peakScope: 'PROCESS_LIFETIME',
      outcome: outcome === 'success' ? 'SUCCESS' : 'FAILURE_OR_INTERRUPTION',
    })
    expect(logs[0]?.['peakResidentSetKiB']).toBeGreaterThan(0)
    expect(logs[0]?.['elapsedMs']).toBeGreaterThanOrEqual(0)
  },
)

test.each(['success', 'failure', 'defect'] as const)(
  'a throwing diagnostic sink preserves the report %s',
  async (outcome) => {
    let attempts = 0
    const report =
      outcome === 'success'
        ? Effect.succeed('report')
        : outcome === 'failure'
          ? Effect.fail('source failure')
          : Effect.die('source defect')
    const expected = await Effect.runPromiseExit(report)
    const exit = await Effect.runPromiseExit(
      withReportResourceMeasurement('throwing-sink', report).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(() => {
              attempts++
              throw new Error('diagnostic sink failed')
            }),
          ]),
        ),
      ),
    )
    expect(attempts).toBe(1)
    expect(exit).toEqual(expected)
  },
)

test.each([false, true])('interruption retains scoped cleanup with a throwing sink: %s', async (throwingSink) => {
  const logs: Readonly<Record<string, unknown>>[] = []
  let finalized = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const fiber = yield* withReportResourceMeasurement(
        'interrupted-report',
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized++
            }),
          ),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* TestClock.adjust('2 seconds')
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provide(
        Logger.layer([
          Logger.make(({ fiber }) => {
            logs.push(fiber.getRef(References.CurrentLogAnnotations))
            if (throwingSink) throw new Error('diagnostic sink failed')
          }),
        ]),
      ),
    ),
  )
  expect(finalized).toBe(1)
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatchObject({ elapsedMs: 2000, outcome: 'FAILURE_OR_INTERRUPTION' })
})

test('the supervisor refuses controller execution before launching a report worker or reading configuration', () => {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      `${import.meta.dir}/forward-performance-command.ts`,
      '--authority-generation',
      'a'.repeat(64),
      '--deadline-ms',
      '30000',
    ],
    env: { BAYN_REPORTING_ALLOWED: 'false', BAYN_OPERATION: 'invalid' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(child.exitCode).toBe(1)
  expect(child.stdout.length).toBe(0)
  expect(child.stderr.toString()).toContain('ReportingRuntimeForbidden')
  expect(child.stderr.toString()).not.toContain('ForwardPerformanceWorkerFailed')
})

test('native Node emits process peak memory on stderr without contaminating report JSON stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-report-resources-'))
  try {
    const build = await Bun.build({
      entrypoints: [`${import.meta.dir}/reporting-runtime.test-support.ts`],
      target: 'node',
      outdir: directory,
    })
    expect(build.success).toBe(true)
    const node = Bun.which('node')
    if (node === null) throw new Error('Native Node is required for report resource validation')
    const child = Bun.spawnSync([node, join(directory, 'reporting-runtime.test-support.js')], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe('{"complete":true}\n')
    const log = JSON.parse(child.stderr.toString())
    expect(log.annotations).toMatchObject({
      command: 'native-report-smoke',
      outcome: 'SUCCESS',
      peakScope: 'PROCESS_LIFETIME',
    })
    expect(log.annotations.peakResidentSetKiB).toBeGreaterThan(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
