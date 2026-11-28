import { fileURLToPath } from 'node:url'

const durableBroker = 'src/intraday-replay/durable-broker.integration.test.ts'
const runtimeFirst = 'src/intraday-replay/runtime.integration.test.ts'
const runtimeSecond = 'src/intraday-replay/runtime-part-2.integration.test.ts'
const groups = {
  runtime: [durableBroker, runtimeFirst, runtimeSecond],
  backtest: ['src/intraday-replay/backtest.integration.test.ts'],
  'latency-jev': ['src/intraday-replay/latency-cli-jev.integration.test.ts'],
  'latency-ablation': ['src/intraday-replay/latency-cli-ablation.integration.test.ts'],
  'latency-momentum': ['src/intraday-replay/latency-cli-momentum.integration.test.ts'],
  'latency-momentum-trading': ['src/intraday-replay/latency-cli-momentum-trading.integration.test.ts'],
  'frozen-control': [],
  restart: ['src/intraday-replay/restart.integration.test.ts'],
  inference: [
    'src/db/native-equity-short.integration.test.ts',
    'src/accounting/equity-short-tigerbeetle.integration.test.ts',
    'src/db/entry-inference-postgres.integration.test.ts',
    'src/inference-expense-postgres.integration.test.ts',
    'src/inference-expense-tigerbeetle.integration.test.ts',
    'src/research-inference/store.integration.test.ts',
  ],
}
const [group = 'all', ...extra] = process.argv.slice(2)
const primaryPostgres = process.env['BAYN_TEST_POSTGRES_URL']?.trim()
const primaryTigerBeetle = process.env['BAYN_TEST_TIGERBEETLE_ADDRESS']?.trim()
const secondPostgres = process.env['BAYN_TEST_SECOND_POSTGRES_URL']?.trim()
const secondTigerBeetle = process.env['BAYN_TEST_SECOND_TIGERBEETLE_ADDRESS']?.trim()
if (
  extra.length > 0 ||
  primaryPostgres === undefined ||
  primaryPostgres === '' ||
  primaryTigerBeetle === undefined ||
  primaryTigerBeetle === '' ||
  (group !== 'all' && !Object.hasOwn(groups, group))
)
  throw Error(
    `Use isolated PostgreSQL and TigerBeetle: bun tools/test-ledger.ts [all|${Object.keys(groups).join('|')}]`,
  )

const directory = fileURLToPath(new URL('..', import.meta.url))
const run = (args: readonly string[], env = process.env) =>
  Bun.spawn([process.execPath, ...args], {
    cwd: directory,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  }).exited

const runFiles = async (files: readonly string[], env = process.env) => {
  for (const file of files) {
    // Tests within one worker own the same disposable schema and must run sequentially.
    const result = await run(['test', '--no-orphans', file], env)
    if (result !== 0) return result
  }
  return 0
}
const postgresPort = (url: string) => new URL(url).port || '5432'

for (const [name, files] of Object.entries(groups)) {
  if (group !== 'all' && group !== name) continue
  if (name === 'runtime' && (secondPostgres !== undefined || secondTigerBeetle !== undefined)) {
    if (
      secondPostgres === undefined ||
      secondPostgres === '' ||
      secondTigerBeetle === undefined ||
      secondTigerBeetle === '' ||
      postgresPort(secondPostgres) === postgresPort(primaryPostgres) ||
      new URL(`tcp://${secondTigerBeetle}`).port === new URL(`tcp://${primaryTigerBeetle}`).port
    )
      throw new Error('Parallel replay requires two isolated PostgreSQL and TigerBeetle servers')
    const [first, second] = await Promise.all([
      runFiles([durableBroker, runtimeFirst]),
      runFiles([runtimeSecond], {
        ...process.env,
        BAYN_TEST_POSTGRES_URL: secondPostgres,
        BAYN_TEST_TIGERBEETLE_ADDRESS: secondTigerBeetle,
      }),
    ])
    if (first !== 0 || second !== 0) process.exit(first || second)
    continue
  }
  const result = await runFiles(files)
  if (result !== 0) process.exit(result)
  if (name === 'frozen-control') {
    const result = await run(['tools/test-frozen-control.ts'])
    if (result !== 0) process.exit(result)
  }
}
