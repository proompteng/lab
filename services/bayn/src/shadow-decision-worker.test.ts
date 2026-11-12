import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { Cause, Effect, Exit, Fiber, Result, Schedule } from 'effect'

import { constructObserveShadowDecision as constructObservation, type ExecutionDecisionInput } from './shadow-decision'
import { decisionConstructionFixture } from './shadow-decision-worker.test-support'
import { decodeCycleDecisionDocument, type ExecutionDecisionDocument } from './shadow-decision-contract'
import { makeDecisionConstruction, type DecisionConstructionRequest } from './decision-construction'

let directory: string
let input: ExecutionDecisionInput
let expected: ExecutionDecisionDocument
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bayn-decision-worker-'))
  await Bun.write(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  const built = await Bun.build({
    entrypoints: [
      'decision-construction-worker.ts',
      'shadow-decision.ts',
      'decision-construction.ts',
      'shadow-decision-worker.test-support.ts',
    ].map((file) => join(import.meta.dir, file)),
    outdir: directory,
    target: 'node',
  })
  if (!built.success) throw new AggregateError(built.logs, 'Decision worker fixture could not build')
  const fixture = await Effect.runPromise(decisionConstructionFixture)
  input = fixture.input
  expected = fixture.expected
})
afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

const spawn = (request: DecisionConstructionRequest) =>
  new Worker(join(directory, 'decision-construction-worker.js'), { workerData: request })
const waitForStart = (signals: Int32Array) =>
  Effect.sync(() => Atomics.load(signals, 0)).pipe(
    Effect.repeat({ until: (value) => value === 1, schedule: Schedule.spaced('1 millis') }),
    Effect.timeout('2 seconds'),
  )
const blockedWorker = (signals: Int32Array) =>
  new Worker(
    `
  const { workerData } = require('node:worker_threads');
  const signals = new Int32Array(workerData);
  Atomics.store(signals, 0, 1);
  Atomics.wait(signals, 1, 0);
`,
    { eval: true, workerData: signals.buffer },
  )

test('execution construction preserves the complete document, hash and owned validation receipt', async () => {
  let worker: Worker | undefined
  const builder = makeDecisionConstruction((request) => {
    worker = spawn(request)
    return worker
  })
  const actual = await Effect.runPromise(builder.execution(input))
  expect(actual).toEqual(expected)
  expect(Object.isFrozen(actual)).toBe(true)
  expect(Object.isFrozen(actual.strategyDecision)).toBe(true)
  expect(Result.getOrThrow(decodeCycleDecisionDocument(actual))).toBe(actual)
  expect(worker?.threadId).toBe(-1)
}, 10_000)

test('observation construction preserves its risk rejection across the thread boundary', async () => {
  const { authorityGenerationHash: _generation, riskContext: _risk, executionSession: _session, ...observation } = input
  const actual = await Effect.runPromise(makeDecisionConstruction(spawn).observe(observation).pipe(Effect.result))
  const expected = await Effect.runPromise(constructObservation(observation).pipe(Effect.result))
  expect(Result.isFailure(actual)).toBe(true)
  expect(Result.isFailure(expected)).toBe(true)
  if (Result.isFailure(actual) && Result.isFailure(expected)) {
    expect(actual.failure.failure).toBe(expected.failure.failure)
    expect(actual.failure.message).toBe(expected.failure.message)
  }
}, 10_000)

test('the production Node build keeps controller timers responsive while constructing the same decision', async () => {
  const script = join(directory, 'check-responsiveness.mjs')
  await Bun.write(
    script,
    `
    import { Effect } from ${JSON.stringify(import.meta.resolve('effect'))};
    import { constructExecutionDecision as direct } from ${JSON.stringify(join(directory, 'shadow-decision.js'))};
    import { buildExecutionDecision as threaded } from ${JSON.stringify(join(directory, 'decision-construction.js'))};
    import { decisionConstructionFixture } from ${JSON.stringify(join(directory, 'shadow-decision-worker.test-support.js'))};
    const { input } = await Effect.runPromise(decisionConstructionFixture);
    async function measure(build) {
      let constructing = true;
      let timerDuringConstruction = false;
      const probe = new Promise(resolve => setTimeout(() => {
        timerDuringConstruction = constructing;
        resolve();
      }, 0));
      const started = performance.now();
      const result = await Effect.runPromise(build(input));
      constructing = false;
      await probe;
      return { hash: result.contentHash, durationMs: performance.now() - started, timerDuringConstruction };
    }
    console.log(JSON.stringify({ direct: await measure(direct), threaded: await measure(threaded) }));
  `,
  )
  const process = Bun.spawn(['node', script], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  const measured = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  expect(measured.threaded.hash).toBe(measured.direct.hash)
  expect(measured.direct.timerDuringConstruction).toBe(false)
  expect(measured.threaded.timerDuringConstruction).toBe(true)
}, 20_000)

test('validation errors retain the domain failure and cause across the thread boundary', async () => {
  const result = await Effect.runPromise(
    makeDecisionConstruction(spawn)
      .execution({
        ...input,
        snapshot: { ...input.snapshot, contentHash: '0'.repeat(64) },
      })
      .pipe(Effect.result),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure).toMatchObject({ _tag: 'ShadowDecisionError', failure: 'binding' })
    expect(result.failure.cause).toBeDefined()
  }
}, 10_000)

test('controller timers advance during synchronous worker work and cancellation terminates that work', async () => {
  const signals = new Int32Array(new SharedArrayBuffer(8))
  let worker: Worker | undefined
  const builder = makeDecisionConstruction(() => {
    worker = blockedWorker(signals)
    return worker
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* builder.execution(input).pipe(Effect.forkChild)
      yield* waitForStart(signals)
      yield* Effect.sleep('20 millis')
      expect(worker?.threadId).not.toBe(-1)
      yield* Fiber.interrupt(running)
      expect(worker?.threadId).toBe(-1)
    }),
  )
}, 10_000)

test('only one construction runs and interruption releases the permit after termination', async () => {
  const signals = new Int32Array(new SharedArrayBuffer(8))
  const workers: Worker[] = []
  const builder = makeDecisionConstruction((request) => {
    const worker = workers.length === 0 ? blockedWorker(signals) : spawn(request)
    workers.push(worker)
    return worker
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* builder.execution(input).pipe(Effect.forkChild)
      yield* waitForStart(signals)
      const second = yield* builder.execution(input).pipe(Effect.forkChild)
      yield* Effect.sleep('20 millis')
      expect(workers).toHaveLength(1)
      yield* Fiber.interrupt(first)
      expect(workers[0]?.threadId).toBe(-1)
      expect(yield* Fiber.join(second)).toEqual(expected)
      expect(workers).toHaveLength(2)
      expect(workers[1]?.threadId).toBe(-1)
    }),
  )
}, 10_000)

test('a deadline kills synchronous work and leaves no worker alive', async () => {
  const signals = new Int32Array(new SharedArrayBuffer(8))
  let worker: Worker | undefined
  const builder = makeDecisionConstruction(() => {
    worker = blockedWorker(signals)
    return worker
  })
  const exit = await Effect.runPromiseExit(builder.execution(input).pipe(Effect.timeout('100 millis')))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(worker?.threadId).toBe(-1)
}, 10_000)

test('spawn and premature-exit failures fail closed', async () => {
  const startup = makeDecisionConstruction(() => {
    throw new Error('Synthetic spawn failure')
  })
  const exited = makeDecisionConstruction(() => new Worker('', { eval: true }))
  for (const builder of [startup, exited]) {
    const result = await Effect.runPromise(builder.execution(input).pipe(Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.failure).toBe('contract')
  }
}, 10_000)

test('worker defects remain defects rather than ordinary decision rejections', async () => {
  const builder = makeDecisionConstruction(
    () =>
      new Worker(
        `
    require('node:worker_threads').parentPort.postMessage({ _tag: 'Defect', cause: new Error('construction defect') });
  `,
        { eval: true },
      ),
  )
  const exit = await Effect.runPromiseExit(builder.execution(input))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
}, 10_000)
