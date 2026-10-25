import { fileURLToPath } from 'node:url'

const files = [
  'src/db/current-authority-migration.integration.test.ts',
  'src/db/remove-unused-schema.integration.test.ts',
  'src/db/current-jev-cycle-migration.integration.test.ts',
  'src/db/explicit-limit-migration.integration.test.ts',
  'src/db/explicit-limit-decision-migration.integration.test.ts',
  'src/db/risk-valuation-query.integration.test.ts',
  'src/db/continuous-cash-spot.integration.test.ts',
  'src/db/available-history-migration.integration.test.ts',
  'src/execution/writer-fence.integration.test.ts',
  'src/db/postgres-backend-tracing.integration.test.ts',
  'src/db/broker-observations.integration.test.ts',
  'src/cycle/store/observability.integration.test.ts',
  'src/db/execution-store.integration.test.ts',
  'src/db/execution-controller-status-postgres.integration.test.ts',
  'src/cycle/store/integration.test.ts',
  'src/execution/intents/blocked-cycle-postgres.integration.test.ts',
  'src/forward-performance/postgres/read.integration.test.ts',
  'src/forward-performance/postgres/cash-reporting.integration.test.ts',
  'src/forward-performance/postgres/strategy.integration.test.ts',
  'src/db/forward-performance-receipt.integration.test.ts',
  'src/db/streaming-snapshot.integration.test.ts',
  'src/db/native-arrival-postgres.integration.test.ts',
  'src/db/jev-evaluation-postgres.integration.test.ts',
  'src/db/jev-batch-postgres.integration.test.ts',
  'src/db/jev-study-export.integration.test.ts',
  'src/db/jev-native-postgres.integration.test.ts',
  'src/intraday-replay/clock.integration.test.ts',
  'src/inference-costs-postgres.integration.test.ts',
  'src/inference-expense-postgres.integration.test.ts',
  'src/research-inference/store.integration.test.ts',
  'src/postgres-monitoring.integration.test.ts',
  'src/cycle/store/entry-allocation-query.integration.test.ts',
]
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

run(['--isolate', `--shard=${shard}`, '--timings=tools/ci-postgres-timings.json', ...files])
if (shard.startsWith('1/')) run(['src/shadow-decision.test.ts', '--test-name-pattern', 'migrated cycle guard'])
