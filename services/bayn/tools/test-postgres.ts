import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localPostgresTestUrl, removePostgresTestDatabases } from './postgres-test-databases'
import timings from './ci-postgres-timings.json'

const files = [
  'tools/auto-ontology-postgres.integration.test.ts',
  'src/db/audit-reader-grants.integration.test.ts',
  'src/db/visual-non-dispatch-migration.integration.test.ts',
  'src/db/equity-short-accounting.integration.test.ts',
  'src/db/candidate-cutover-diagnostics.integration.test.ts',
  'src/db/candidate-observation-window.integration.test.ts',
  'src/db/current-authority-migration.integration.test.ts',
  'src/db/effective-entry-observe-cutover.integration.test.ts',
  'src/db/remove-unused-schema.integration.test.ts',
  'src/db/current-jev-cycle-migration.integration.test.ts',
  'src/db/explicit-limit-migration.integration.test.ts',
  'src/db/explicit-limit-decision-migration.integration.test.ts',
  'src/db/risk-valuation-query.integration.test.ts',
  'src/db/continuous-cash-spot.integration.test.ts',
  'src/db/available-history-migration.integration.test.ts',
  'src/db/jev-management-migration.integration.test.ts',
  'src/db/jev-trade-plan-migration.integration.test.ts',
  'src/db/jev-entry-limits-migration.integration.test.ts',
  'src/execution/writer-fence.integration.test.ts',
  'src/execution/mutations/expired-entry-cancellation.integration.test.ts',
  'src/db/postgres-backend-tracing.integration.test.ts',
  'src/db/snapshot-rows.integration.test.ts',
  'src/db/broker-observations.integration.test.ts',
  'src/db/broker-protection-binding.integration.test.ts',
  'src/cycle/store/observability.integration.test.ts',
  'src/db/execution-store.integration.test.ts',
  'src/db/execution-store/configured-account.integration.test.ts',
  'src/db/execution-controller-status-postgres.integration.test.ts',
  'src/cycle/store/integration.test.ts',
  'src/execution/intents/blocked-cycle-postgres.integration.test.ts',
  'src/forward-performance/postgres/read.integration.test.ts',
  'src/forward-performance/postgres/alpha-decisions.integration.test.ts',
  'src/forward-performance/postgres/cycles.integration.test.ts',
  'src/forward-performance/postgres/first-cycle-queries.integration.test.ts',
  'src/forward-performance/postgres/inference-expense-sessions.integration.test.ts',
  'src/forward-performance/postgres/cash-reporting.integration.test.ts',
  'src/forward-performance/postgres/strategy.integration.test.ts',
  'src/db/forward-performance-receipt.integration.test.ts',
  'src/db/streaming-snapshot.integration.test.ts',
  'src/db/native-arrival-postgres.integration.test.ts',
  'src/native-arrival-export-command.integration.test.ts',
  'src/db/jev-evaluation-postgres.integration.test.ts',
  'src/db/jev-evaluation-cohort-postgres.integration.test.ts',
  'src/db/jev-batch-admission-postgres.integration.test.ts',
  'src/db/jev-batch-dispatch-postgres.integration.test.ts',
  'src/db/jev-batch-evidence-postgres.integration.test.ts',
  'src/db/jev-batch-expiry-paging-postgres.integration.test.ts',
  'src/db/jev-batch-expiry-postgres.integration.test.ts',
  'src/db/jev-batch-finalization-postgres.integration.test.ts',
  'src/db/jev-batch-postgres.integration.test.ts',
  'src/db/jev-batch-worker-postgres.integration.test.ts',
  'src/db/retired-jev-batch-migration.integration.test.ts',
  'src/db/jev-study-export.integration.test.ts',
  'src/db/jev-native-entry-receipts-postgres.integration.test.ts',
  'src/db/jev-native-entry-replay-postgres.integration.test.ts',
  'src/db/jev-native-exit-deadline-postgres.integration.test.ts',
  'src/db/jev-native-exit-recovery-postgres.integration.test.ts',
  'src/db/jev-native-position-postgres.integration.test.ts',
  'src/db/jev-position-protection-evidence.integration.test.ts',
  'src/intraday-replay/clock.integration.test.ts',
  'src/inference-costs-postgres.integration.test.ts',
  'src/inference-expense-runtime.integration.test.ts',
  'src/inference-expense-listener.integration.test.ts',
  'src/postgres-monitoring.integration.test.ts',
  'src/cycle/store/entry-allocation-query.integration.test.ts',
  'src/system-assessment/postgres.integration.test.ts',
  'src/system-assessment/alpha-observation-witness.integration.test.ts',
  'src/system-assessment/alpha-baseline-witness.integration.test.ts',
  'src/system-assessment/operational-source-cut.integration.test.ts',
  'src/db/risk-clock-rejection.integration.test.ts',
]
const shadowDecisions = 'src/shadow-decision.test.ts'
const [shard = '1/1', ...extra] = process.argv.slice(2)
const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard)
const index = Number(match?.[1]) - 1
const count = Number(match?.[2])
if (
  match === null ||
  index >= count ||
  count > files.length ||
  extra.length > 0 ||
  process.env['BAYN_TEST_POSTGRES_URL'] === undefined
)
  throw new Error(
    'Usage: BAYN_TEST_POSTGRES_URL=<isolated local _test database> bun tools/test-postgres.ts [index/count]',
  )

const byFile = new Map(Object.entries(timings.files))
const measured = [...byFile.values()].sort((left, right) => left - right)
const median = measured[Math.floor(measured.length / 2)] ?? 1
const duration = (file: string) => byFile.get(file) ?? median
const shards = Array.from({ length: count }, (_, index) => ({
  files: new Array<string>(),
  milliseconds: index === 0 ? duration(shadowDecisions) : 0,
}))

// Each worker builds the same plan from the checked-out snapshot and file list.
for (const file of files.toSorted().sort((left, right) => duration(right) - duration(left))) {
  // Fill empty shards first so a request for one shard per file still runs each file.
  const empty = shards.filter((shard) => shard.files.length === 0)
  const lightest = (empty.length === 0 ? shards : empty).reduce((best, candidate) =>
    candidate.milliseconds < best.milliseconds ? candidate : best,
  )
  lightest.files.push(file)
  lightest.milliseconds += duration(file)
}
const assigned = shards[index]
if (assigned === undefined || assigned.files.length === 0) throw new Error(`PostgreSQL shard ${shard} has no files`)

const timingsPath = process.env['BAYN_CI_POSTGRES_TIMINGS_PATH'] ?? ''
const recordTimings = timingsPath !== ''
const recordedTimings = recordTimings ? [`--timings=${timingsPath}`, '--update-timings'] : []
const testUrl = localPostgresTestUrl(process.env['BAYN_TEST_POSTGRES_URL'])

const run = async (expected: readonly string[], args: readonly string[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-postgres-results-'))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const prefix = `bayn_file_${crypto.randomUUID().replaceAll('-', '')}_`
  try {
    const report = join(directory, 'results.xml')
    const result = Bun.spawnSync(
      [
        process.execPath,
        'test',
        '--no-orphans',
        '--isolate',
        '--randomize',
        '--preload=./tools/postgres-file-preload.ts',
        '--reporter=junit',
        `--reporter-outfile=${report}`,
        ...args,
        ...expected.map((file) => `./${file}`),
      ],
      {
        cwd,
        env: { ...process.env, BAYN_TEST_POSTGRES_FILE_PREFIX: prefix },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
    if (result.exitCode !== 0) process.exitCode = result.exitCode
    else {
      const checked = Bun.spawnSync(['python3', 'scripts/verify-integration-results.py', report, ...expected], {
        cwd,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      process.exitCode = checked.exitCode
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
    // Bun cannot run a file's teardown if module loading failed.
    await removePostgresTestDatabases(testUrl, prefix)
  }
  if (process.exitCode !== 0) process.exit(process.exitCode)
}

console.log(
  `PostgreSQL shard ${shard}: ${assigned.files.length}/${files.length} files, estimated ${assigned.milliseconds}ms`,
)
await run(assigned.files, recordedTimings)
if (index === 0) {
  await run(
    [shadowDecisions],
    [
      ...(recordTimings ? [`--timings=${timingsPath}.shadow.json`, '--update-timings'] : []),
      '--test-name-pattern',
      'migrated cycle guard|PostgreSQL entry binding and nested',
    ],
  )
}
