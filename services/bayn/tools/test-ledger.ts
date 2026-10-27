import { fileURLToPath } from 'node:url'

const groups = {
  runtime: [
    'src/intraday-replay/durable-broker.integration.test.ts',
    'src/intraday-replay/runtime.integration.test.ts',
  ],
  backtest: ['src/intraday-replay/backtest.integration.test.ts'],
  'frozen-control': [],
  restart: ['src/intraday-replay/restart.integration.test.ts'],
  inference: [
    'src/db/entry-inference-postgres.integration.test.ts',
    'src/inference-expense-postgres.integration.test.ts',
    'src/inference-expense-tigerbeetle.integration.test.ts',
    'src/research-inference/store.integration.test.ts',
  ],
}
const [group = 'all', ...extra] = process.argv.slice(2)
if (
  extra.length > 0 ||
  (process.env['BAYN_TEST_POSTGRES_URL'] ?? '').trim().length === 0 ||
  (process.env['BAYN_TEST_TIGERBEETLE_ADDRESS'] ?? '').trim().length === 0 ||
  (group !== 'all' && !Object.hasOwn(groups, group))
)
  throw Error(
    'Use isolated PostgreSQL and TigerBeetle: bun tools/test-ledger.ts [all|runtime|backtest|frozen-control|restart|inference]',
  )

for (const [name, files] of Object.entries(groups)) {
  if (group !== 'all' && group !== name) continue
  for (const file of files) {
    // Each suite owns the same disposable schema, so files within a job must remain sequential.
    const result = Bun.spawnSync([process.execPath, 'test', '--no-orphans', file], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (result.exitCode !== 0) process.exit(result.exitCode)
  }
  if (name === 'frozen-control') {
    const result = Bun.spawnSync([process.execPath, 'tools/test-frozen-control.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (result.exitCode !== 0) process.exit(result.exitCode)
  }
}
