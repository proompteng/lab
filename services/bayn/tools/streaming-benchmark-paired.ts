import { NodeRuntime } from '@effect/platform-node'
import { Cause, Data, Effect, Exit, Schedule, Schema } from 'effect'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { availableParallelism, homedir, loadavg, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const node = '/nix/store/h57ln4r40qr349z1r8ri90n9i9xid3r5-nodejs-24.11.1/bin/node'
const postgresContainer = 'bayn-streaming-postgres18-test'
const tigerBeetleImage =
  'ghcr.io/tigerbeetle/tigerbeetle@sha256:48f623f9c1e9b6cc44d77ca93634595ae99cce3246ded418763eb1a62eee45e9'
const tigerBeetlePort = 57962
const dockerHost = `unix://${join(homedir(), '.docker/run/docker.sock')}`
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const Json = Schema.fromJsonString(Schema.Unknown)
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const Scenario = Schema.Literals(['trade', 'no-trade', 'provider-unknown'])
type Scenario = typeof Scenario.Type
const Snapshot = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.streaming-benchmark-snapshot.v1'),
  revision: Revision,
  instrumentation: Schema.Null,
  harnesses: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Sha })),
  outputs: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Sha })),
})
const Fill = Schema.Struct({
  symbol: Schema.String,
  side: Schema.String,
  quantityAtoms: Schema.String,
  priceMicros: Schema.String,
  notionalMicros: Schema.String,
})
const Position = Schema.Struct({ symbol: Schema.String, quantityAtoms: Schema.String, costBasisMicros: Schema.String })
const Candidate = Schema.Struct({
  symbol: Schema.String,
  status: Schema.String,
  reason: Schema.optionalKey(Schema.String),
})
const Counts = Schema.Struct({
  intents: Schema.Int,
  submit_started: Schema.Int,
  fills: Schema.Int,
  accounting_transactions: Schema.Int,
  accounting_receipts: Schema.Int,
  inference_requests: Schema.Int,
  inference_receipts: Schema.Int,
  batch_plans: Schema.Int,
  batch_results: Schema.Int,
})
const Report = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.matched-financial-benchmark.v1'),
  sourceRevision: Revision,
  scenario: Scenario,
  versions: Schema.Struct({ node: Schema.Literal('24.11.1'), postgres: Schema.String }),
  measurement: Schema.Struct({
    physicalWallMs: Schema.Finite,
    cpuUserMicros: Schema.Finite,
    cpuSystemMicros: Schema.Finite,
  }),
  workload: Schema.Struct({
    sourceHash: Sha,
    inputBytesHash: Sha,
    records: Schema.Int,
    publishedRecords: Schema.Int,
    runId: Sha,
    accountId: Schema.String,
    originalEligibleAt: Schema.String,
    originalWindowEndAt: Schema.String,
    lastAt: Schema.String,
    cadenceMs: Schema.Int,
    providerJevDelayMs: Schema.Int,
    openingCashMicros: Schema.String,
  }),
  opportunities: Schema.Struct({
    declaredCandidateSymbols: Schema.Array(Schema.String),
    persistedCandidateOutcomes: Schema.Array(
      Schema.Struct({
        plan: Schema.Struct({ candidates: Schema.Array(Candidate) }),
        result: Schema.NullOr(Schema.Struct({ candidates: Schema.Array(Candidate) })),
      }),
    ),
    schedule: Schema.Struct({
      passCount: Schema.Int,
      failedPassCount: Schema.Int,
      unavailableDecisionPassCount: Schema.Int,
      readinessCounts: Schema.Record(Schema.String, Schema.Int),
    }),
    providerDispatchCount: Schema.Int,
    providerCalls: Schema.Array(
      Schema.Struct({ stage: Schema.String, outcome: Schema.Struct({ status: Schema.String }) }),
    ),
  }),
  work: Schema.Struct({ counts: Counts }),
  financial: Schema.Struct({
    state: Schema.Struct({
      ledger: Schema.Struct({
        openingCashMicros: Schema.String,
        cashMicros: Schema.String,
        executionFeesMicros: Schema.String,
        netRealizedPnlAfterCostsMicros: Schema.NullOr(Schema.String),
        positions: Schema.Array(Position),
        fills: Schema.Array(Fill),
      }),
    }),
    authority: Schema.Struct({ maximum: Schema.String, effective: Schema.String, kill: Schema.String }),
    reconciliation: Schema.Struct({
      report: Schema.Struct({
        reconciliation: Schema.Struct({ status: Schema.Literal('EXACT') }),
        metrics: Schema.Struct({
          cashDifferenceMicros: Schema.String,
          positionDifferenceMicros: Schema.String,
          equityDifferenceMicros: Schema.String,
          accountingExact: Schema.Boolean,
          discrepancyCount: Schema.Int,
          oldestUnknownMutationAgeMs: Schema.Int,
        }),
      }),
      brokerState: Schema.Struct({ unknownOrderCount: Schema.Int }),
      riskContext: Schema.Struct({ unknownMutationCount: Schema.Int }),
    }),
  }),
})
type Report = typeof Report.Type
class BenchmarkError extends Data.TaggedError('BenchmarkError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const command = (argv: readonly [string, ...string[]]) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
        const arguments_ = argv[0] === 'docker' ? [`--host=${dockerHost}`, ...argv.slice(1)] : argv.slice(1)
        execFile(
          argv[0],
          arguments_,
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000, signal },
          (error, stdout, stderr) => {
            if (error !== null) reject(new Error(`${argv[0]} ${argv[1] ?? ''} failed: ${error.message}\n${stderr}`))
            else accept({ stdout, stderr })
          },
        )
      }),
    catch: (cause) => new BenchmarkError({ message: 'Benchmark command failed', cause }),
  })
const io = <A>(operation: () => Promise<A>) => Effect.tryPromise(operation)
const writeJson = (path: string, value: unknown) => io(() => writeFile(path, JSON.stringify(value, null, 2) + '\n'))
const connectLedger = Effect.tryPromise(
  (signal) =>
    new Promise<void>((accept, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: tigerBeetlePort, signal }, () => {
        socket.end()
        accept()
      })
      socket.once('error', reject)
    }),
).pipe(Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 199 }))

const [baselineArgument, candidateArgument, reportArgument, repetitionsArgument = '5', scenarioArgument = 'all'] =
  process.argv.slice(2)
if (
  baselineArgument === undefined ||
  candidateArgument === undefined ||
  reportArgument === undefined ||
  !/^\d+$/.test(repetitionsArgument)
)
  throw new Error(
    'Usage: bun tools/streaming-benchmark-paired.ts <baseline-bundle> <candidate-bundle> <report-directory> [repetitions=5] [all|trade|no-trade|provider-unknown]',
  )
const repetitions = Number(repetitionsArgument)
if (!Number.isSafeInteger(repetitions) || repetitions < 5 || repetitions > 100)
  throw new Error('Paired benchmark requires 5–100 repetitions')
const scenarios =
  scenarioArgument === 'all'
    ? Schema.decodeUnknownSync(Schema.Array(Scenario))(['trade', 'no-trade', 'provider-unknown'])
    : [Schema.decodeUnknownSync(Scenario)(scenarioArgument)]
const baselineDirectory = resolve(baselineArgument)
const candidateDirectory = resolve(candidateArgument)
const outputDirectory = resolve(reportArgument)
if (baselineDirectory === candidateDirectory)
  throw new Error('Baseline and candidate must be distinct exact snapshot artifacts')
const token = randomUUID().replaceAll('-', '').slice(0, 12)
type Side = 'baseline' | 'candidate'
type Attempt = {
  scenario: Scenario
  repetition: number
  side: Side
  status: 'pending' | 'running' | 'complete' | 'failed'
  reportPath: string
  logPath: string
  reportHash: string | null
  result: Report | null
  failure: string | null
}
const attempts: Attempt[] = scenarios.flatMap((scenario) =>
  Array.from({ length: repetitions }, (_, repetition) =>
    (repetition % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']).map((side) => ({
      scenario,
      repetition,
      side: Schema.decodeUnknownSync(Schema.Literals(['baseline', 'candidate']))(side),
      status: 'pending' as const,
      reportPath: join(outputDirectory, `${scenario}-${repetition + 1}-${side}.json`),
      logPath: join(outputDirectory, `${scenario}-${repetition + 1}-${side}.log`),
      reportHash: null,
      result: null,
      failure: null,
    })),
  ).flat(),
)
const percentile = (values: readonly number[], fraction: number) => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
}
const statistics = (values: readonly number[]) => ({
  method: 'nearest-rank; p95 equals the observed maximum when n=5',
  n: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  minimum: values.length === 0 ? null : Math.min(...values),
  maximum: values.length === 0 ? null : Math.max(...values),
})
const normalized = (report: Report) => ({
  workload: report.workload,
  ledger: report.financial.state.ledger,
  authority: report.financial.authority,
  reconciliation: report.financial.reconciliation,
  counts: report.work.counts,
  candidates: report.opportunities.persistedCandidateOutcomes.map(({ plan, result }) => ({
    plan: plan.candidates,
    result: result?.candidates ?? null,
  })),
  declaredCandidateSymbols: report.opportunities.declaredCandidateSymbols,
  providerDispatchCount: report.opportunities.providerDispatchCount,
  providerOutcomes: report.opportunities.providerCalls
    .map(({ stage, outcome }) => `${stage}:${outcome.status}`)
    .toSorted(),
})
const verifySnapshot = (directory: string) =>
  Effect.gen(function* () {
    const path = join(directory, 'snapshot.json')
    const original = yield* io(() => readFile(path, 'utf8'))
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))(original)
    for (const output of manifest.outputs) {
      const local = join(directory, basename(output.path))
      const bytes = yield* io(() => readFile(local))
      if (hash(bytes) !== output.sha256) return yield* Effect.die(`Snapshot output changed: ${local}`)
    }
    const harness = manifest.harnesses.find(
      ({ path }) => path === 'services/bayn/tools/streaming-benchmark-financial.ts',
    )
    if (
      harness === undefined ||
      !manifest.outputs.some(({ path }) => basename(path) === 'streaming-benchmark-financial.js')
    )
      return yield* Effect.die('Exact snapshot lacks the financial harness or its output hash')
    return {
      directory,
      snapshotPath: path,
      snapshotHash: hash(original),
      original,
      manifest,
      harnessHash: harness.sha256,
    }
  })

const runAttempt = (attempt: Attempt, snapshot: { directory: string; manifest: typeof Snapshot.Type }) =>
  Effect.gen(function* () {
    const suffix = `${token}-${attempt.repetition}-${attempt.side === 'baseline' ? 'a' : 'b'}-${attempt.scenario === 'trade' ? 't' : attempt.scenario === 'no-trade' ? 'n' : 'u'}`
    const database = `bayn_pair_${suffix.replaceAll('-', '_')}_test`
    const container = `bayn-pair-${suffix}`
    const formatContainer = `${container}-format`
    if (!/^bayn_pair_[a-z0-9_]+_test$/.test(database) || !/^bayn-pair-[a-z0-9-]+$/.test(container))
      return yield* Effect.die('Invalid task-owned resource identity')
    const directory = yield* io(() => mkdtemp(join(tmpdir(), `bayn-pair-${suffix}-`)))
    const ledger = join(directory, '0_0.tigerbeetle')
    let ownsDatabase = false
    const removeContainer = (name: string) =>
      Effect.gen(function* () {
        const lookup = yield* command([
          'docker',
          'container',
          'inspect',
          '--format',
          '{{index .Config.Labels "bayn.benchmark.run"}}',
          name,
        ]).pipe(Effect.result)
        if (lookup._tag === 'Failure') {
          const reason = String(lookup.failure.cause)
          if (reason.includes('No such object') || reason.includes('No such container')) return
          return yield* lookup.failure
        }
        if (lookup.success.stdout.trim() !== token)
          return yield* Effect.die(`Refusing cleanup of a container without this benchmark label: ${name}`)
        yield* command(['docker', 'container', 'rm', '--force', name])
      })
    const cleanup = Effect.gen(function* () {
      const operations: Array<Effect.Effect<void, BenchmarkError | Cause.UnknownError>> = [
        removeContainer(container),
        removeContainer(formatContainer),
        ownsDatabase
          ? command([
              'docker',
              'exec',
              postgresContainer,
              'dropdb',
              '--username=bayn',
              '--if-exists',
              '--force',
              database,
            ]).pipe(Effect.asVoid)
          : Effect.void,
        io(() => unlink(ledger)).pipe(
          Effect.catch((error) =>
            error.cause !== null &&
            typeof error.cause === 'object' &&
            'code' in error.cause &&
            error.cause.code === 'ENOENT'
              ? Effect.void
              : Effect.fail(error),
          ),
        ),
        io(() => rmdir(directory)),
      ]
      const results = yield* Effect.all(
        operations.map((operation) => Effect.exit(operation)),
        { concurrency: 1 },
      )
      const failed = results.find(Exit.isFailure)
      if (failed !== undefined) return yield* failed
    })
    return yield* Effect.gen(function* () {
      const existing = yield* command([
        'docker',
        'exec',
        postgresContainer,
        'psql',
        '-U',
        'bayn',
        '-d',
        'postgres',
        '-Atc',
        `SELECT datname FROM pg_database WHERE datname='${database}'`,
      ])
      if (existing.stdout.trim() !== '') return yield* Effect.die('Task database already exists; preserving it')
      ownsDatabase = true
      yield* command(['docker', 'exec', postgresContainer, 'createdb', '--username=bayn', '--owner=bayn', database])
      yield* command([
        'docker',
        'run',
        '--pull=never',
        '--rm',
        '--name',
        formatContainer,
        '--label',
        `bayn.benchmark.run=${token}`,
        '--volume',
        `${directory}:/data`,
        tigerBeetleImage,
        'format',
        '--cluster=20912',
        '--replica=0',
        '--replica-count=1',
        '--development',
        '/data/0_0.tigerbeetle',
      ])
      yield* command([
        'docker',
        'run',
        '--pull=never',
        '--detach',
        '--name',
        container,
        '--label',
        `bayn.benchmark.run=${token}`,
        '--publish',
        `127.0.0.1:${tigerBeetlePort}:3000`,
        '--volume',
        `${directory}:/data`,
        tigerBeetleImage,
        'start',
        '--addresses=0.0.0.0:3000',
        '--development',
        '/data/0_0.tigerbeetle',
      ])
      yield* connectLedger
      const execution = yield* command([
        node,
        join(snapshot.directory, 'streaming-benchmark-financial.js'),
        `postgresql://bayn@127.0.0.1:55438/${database}`,
        `127.0.0.1:${tigerBeetlePort}`,
        attempt.reportPath,
        snapshot.manifest.revision,
        attempt.scenario,
      ]).pipe(Effect.result)
      yield* io(() =>
        writeFile(
          attempt.logPath,
          execution._tag === 'Success'
            ? execution.success.stdout + execution.success.stderr
            : String(execution.failure.cause),
        ),
      )
      if (execution._tag === 'Failure') return yield* execution.failure
      const bytes = yield* io(() => readFile(attempt.reportPath, 'utf8'))
      const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(bytes)
      if (report.sourceRevision !== snapshot.manifest.revision || report.scenario !== attempt.scenario)
        return yield* Effect.die('Financial result differs from its selected source/scenario')
      attempt.reportHash = hash(bytes)
      attempt.result = report
      attempt.status = 'complete'
    }).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)))
  })

const program = Effect.gen(function* () {
  yield* io(() => mkdir(outputDirectory, { recursive: true }))
  if ((yield* io(() => readdir(outputDirectory))).length > 0)
    return yield* Effect.die('Preserving prior evidence: paired report directory must be empty')
  const baseline = yield* verifySnapshot(baselineDirectory)
  const candidate = yield* verifySnapshot(candidateDirectory)
  if (baseline.manifest.revision === candidate.manifest.revision || baseline.harnessHash !== candidate.harnessHash)
    return yield* Effect.die('Paired comparison requires different exact revisions and the identical financial harness')
  const version = yield* command([node, '--version'])
  if (version.stdout.trim() !== 'v24.11.1') return yield* Effect.die('Pinned Node24.11.1 is unavailable')
  const summaryPath = join(outputDirectory, 'paired-financial-summary.json')
  const source = yield* io(() => readFile(import.meta.path, 'utf8'))
  const provenance = {
    schemaVersion: 'bayn.matched-financial-pairs.v1',
    benchmark: { path: import.meta.path, sha256: hash(source), bunVersion: Bun.version },
    scope:
      'Physical time of actual offline financial work at fixed 1000ms replay cadence; not end-to-end streaming latency',
    setupExcluded: true,
    nominalConfidence: 'At least five pairs; p95 is descriptive, no p99 or production latency claim',
    inputs: { baselineDirectory, candidateDirectory, outputDirectory, repetitions, scenarios },
    resources: {
      node,
      dockerHost,
      postgresContainer,
      postgresAddress: '127.0.0.1:55438',
      tigerBeetleImage,
      tigerBeetleAddress: `127.0.0.1:${tigerBeetlePort}`,
      clusterId: '20912',
      ledger: 70912,
    },
    sharedHost: { cores: availableParallelism(), initialLoadAverage: loadavg() },
    baseline: {
      path: baseline.snapshotPath,
      hash: baseline.snapshotHash,
      manifest: yield* Schema.decodeUnknownEffect(Json)(baseline.original),
    },
    candidate: {
      path: candidate.snapshotPath,
      hash: candidate.snapshotHash,
      manifest: yield* Schema.decodeUnknownEffect(Json)(candidate.original),
    },
  }
  const save = writeJson(summaryPath, { ...provenance, complete: false, attempts: [] })
  yield* save
  const paired: Array<{
    scenario: Scenario
    repetition: number
    baselineMs: number
    candidateMs: number
    deltaMs: number
    deltaPercent: number
    economicHash: string
  }> = []
  let failure: string | null = null
  const writeSummary = (complete: boolean) =>
    writeJson(summaryPath, {
      ...provenance,
      complete,
      failure,
      verdict: complete
        ? 'Observed component timing only; inspect paired variability before inferring a change'
        : 'Incomplete; do not use successful-only timings for a performance conclusion',
      attempts: attempts.map(({ result, ...attempt }) => ({
        ...attempt,
        measurement: result?.measurement ?? null,
        outcomeCoverage: result?.opportunities.schedule ?? null,
      })),
      pairs: paired,
      statistics: scenarios.map((scenario) => ({
        scenario,
        baselinePhysicalWallMs: statistics(
          paired.filter((pair) => pair.scenario === scenario).map((pair) => pair.baselineMs),
        ),
        candidatePhysicalWallMs: statistics(
          paired.filter((pair) => pair.scenario === scenario).map((pair) => pair.candidateMs),
        ),
        deltaPhysicalWallMs: statistics(
          paired.filter((pair) => pair.scenario === scenario).map((pair) => pair.deltaMs),
        ),
      })),
    })
  return yield* Effect.gen(function* () {
    for (const attempt of attempts) {
      attempt.status = 'running'
      yield* writeSummary(false)
      const result = yield* runAttempt(attempt, attempt.side === 'baseline' ? baseline : candidate).pipe(Effect.exit)
      if (Exit.isFailure(result)) {
        attempt.status = 'failed'
        attempt.failure = Cause.pretty(result.cause)
        return yield* result
      }
      const other = attempts.find(
        (value) =>
          value.scenario === attempt.scenario &&
          value.repetition === attempt.repetition &&
          value.side !== attempt.side &&
          value.result !== null,
      )
      if (other?.result !== null && other?.result !== undefined && attempt.result !== null) {
        const before = attempt.side === 'baseline' ? attempt.result : other.result
        const after = attempt.side === 'candidate' ? attempt.result : other.result
        const beforeJson = JSON.stringify(normalized(before))
        const afterJson = JSON.stringify(normalized(after))
        if (beforeJson !== afterJson) {
          yield* writeJson(join(outputDirectory, `${attempt.scenario}-${attempt.repetition + 1}-parity-failure.json`), {
            baseline: normalized(before),
            candidate: normalized(after),
          })
          return yield* Effect.die(
            `Financial/evidence parity failed for ${attempt.scenario} pair${attempt.repetition + 1}; all raw reports retained`,
          )
        }
        const baselineMs = before.measurement.physicalWallMs
        const candidateMs = after.measurement.physicalWallMs
        paired.push({
          scenario: attempt.scenario,
          repetition: attempt.repetition + 1,
          baselineMs,
          candidateMs,
          deltaMs: candidateMs - baselineMs,
          deltaPercent: (candidateMs / baselineMs - 1) * 100,
          economicHash: hash(beforeJson),
        })
      }
      yield* writeSummary(false)
      process.stdout.write(
        JSON.stringify({
          side: attempt.side,
          scenario: attempt.scenario,
          repetition: attempt.repetition + 1,
          status: attempt.status,
          physicalWallMs: attempt.result?.measurement.physicalWallMs,
        }) + '\n',
      )
    }
    yield* writeSummary(true)
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) return Effect.void
      failure = Cause.pretty(exit.cause)
      return writeSummary(false).pipe(Effect.orDie)
    }),
  )
})

NodeRuntime.runMain(program)
