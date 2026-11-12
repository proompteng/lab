import { fileURLToPath } from 'node:url'
import timings from './ci-postgres-timings.json'

export const postgresFiles = [
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
  'src/execution/writer-fence.integration.test.ts',
  'src/execution/mutations/expired-entry-cancellation.integration.test.ts',
  'src/db/postgres-backend-tracing.integration.test.ts',
  'src/db/snapshot-rows.integration.test.ts',
  'src/db/broker-observations.integration.test.ts',
  'src/cycle/store/observability.integration.test.ts',
  'src/db/execution-store.integration.test.ts',
  'src/db/execution-controller-status-postgres.integration.test.ts',
  'src/cycle/store/integration.test.ts',
  'src/execution/intents/blocked-cycle-postgres.integration.test.ts',
  'src/forward-performance/postgres/read.integration.test.ts',
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
  'src/db/jev-batch-postgres.integration.test.ts',
  'src/db/retired-jev-batch-migration.integration.test.ts',
  'src/db/jev-study-export.integration.test.ts',
  'src/db/jev-native-postgres.integration.test.ts',
  'src/intraday-replay/clock.integration.test.ts',
  'src/inference-costs-postgres.integration.test.ts',
  'src/inference-expense-runtime.integration.test.ts',
  'src/postgres-monitoring.integration.test.ts',
  'src/cycle/store/entry-allocation-query.integration.test.ts',
  'src/system-assessment/postgres.integration.test.ts',
  'src/system-assessment/operational-source-cut.integration.test.ts',
  'src/db/risk-clock-rejection.integration.test.ts',
]

// Bun 1.4.2 keeps contiguous path ranges together; database setup dominates these isolated suites.
export const postgresShard = (shard: string, weights: Readonly<Record<string, number>>): string[] => {
  const parts = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard)
  if (parts === null) throw Error('Expected PostgreSQL shard index/count')
  const index = Number(parts[1])
  const count = Number(parts[2])
  if (count > postgresFiles.length) throw Error('PostgreSQL shards must each own a test file')
  const bins = Array.from({ length: count }, () => ({ files: [] as string[], milliseconds: 0 }))
  const selected = bins[index - 1]
  if (selected === undefined) throw Error('PostgreSQL shard index exceeds its count')
  const measured = Object.values(weights).sort((a, b) => a - b)
  const median = measured[Math.floor(measured.length / 2)] ?? 0
  const cost = (file: string) => Math.max(1, weights[file] ?? median)
  for (const file of [...postgresFiles].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const lightest = bins.reduce((a, b) => (b.milliseconds < a.milliseconds ? b : a))
    lightest.files.push(file)
    lightest.milliseconds += cost(file)
  }
  return selected.files
}

if (import.meta.main) {
  if (process.argv[2] === '--list') {
    console.log(JSON.stringify(postgresFiles))
    process.exit(0)
  }
  const [shard = '1/1', ...extra] = process.argv.slice(2)
  if (extra.length > 0 || process.env['BAYN_TEST_POSTGRES_URL'] === undefined)
    throw new Error(
      'Usage: BAYN_TEST_POSTGRES_URL=<isolated local _test database> bun tools/test-postgres.ts [index/count]',
    )

  const run = (args: readonly string[]) => {
    const result = Bun.spawnSync([process.execPath, 'test', '--no-orphans', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (result.exitCode !== 0) process.exit(result.exitCode)
  }

  run([
    '--isolate',
    '--timings=tools/ci-postgres-timings.json',
    '--update-timings',
    '--reporter=junit',
    '--reporter-outfile=postgres-results.xml',
    ...postgresShard(shard, timings.files).map((file) => `./${file}`),
  ])
  if (shard.startsWith('1/'))
    run([
      'src/shadow-decision.test.ts',
      '--test-name-pattern',
      'migrated cycle guard|PostgreSQL entry binding and nested',
    ])
}
