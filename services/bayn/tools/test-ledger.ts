import { fileURLToPath } from 'node:url'
import { JevResearchPolicy } from '../src/jev/acceptance'

const backtestFile = 'src/intraday-replay/backtest.integration.test.ts'
const groups: Record<string, { readonly files: readonly string[]; readonly testNamePattern?: string }> = {
  runtime: {
    files: [
      'src/intraday-replay/durable-broker.integration.test.ts',
      'src/intraday-replay/runtime.integration.test.ts',
    ],
  },
  'backtest-core': {
    files: [backtestFile],
    testNamePattern: '^(?!.* latency CLI retains twenty sessions with trading=)',
  },
  'backtest-latency-jev': {
    files: [backtestFile],
    testNamePattern: `native ${JevResearchPolicy.Candidate} latency CLI retains twenty sessions with trading=false$`,
  },
  'backtest-latency-ablation': {
    files: [backtestFile],
    testNamePattern: `native ${JevResearchPolicy.Ablation} latency CLI retains twenty sessions with trading=false$`,
  },
  'backtest-latency-momentum': {
    files: [backtestFile],
    testNamePattern: `native ${JevResearchPolicy.Momentum} latency CLI retains twenty sessions with trading=false$`,
  },
  'backtest-latency-momentum-trading': {
    files: [backtestFile],
    testNamePattern: `native ${JevResearchPolicy.Momentum} latency CLI retains twenty sessions with trading=true$`,
  },
  'frozen-control': { files: [] },
  restart: { files: ['src/intraday-replay/restart.integration.test.ts'] },
  inference: {
    files: [
      'src/db/entry-inference-postgres.integration.test.ts',
      'src/inference-expense-postgres.integration.test.ts',
      'src/inference-expense-tigerbeetle.integration.test.ts',
      'src/research-inference/store.integration.test.ts',
    ],
  },
}
const [group = 'all', ...extra] = process.argv.slice(2)
if (
  extra.length > 0 ||
  (process.env['BAYN_TEST_POSTGRES_URL'] ?? '').trim().length === 0 ||
  (process.env['BAYN_TEST_TIGERBEETLE_ADDRESS'] ?? '').trim().length === 0 ||
  (group !== 'all' && !Object.hasOwn(groups, group))
)
  throw Error(
    `Use isolated PostgreSQL and TigerBeetle: bun tools/test-ledger.ts [all|${Object.keys(groups).join('|')}]`,
  )

for (const [name, { files, testNamePattern }] of Object.entries(groups)) {
  if (group !== 'all' && group !== name) continue
  for (const file of files) {
    // Each suite owns the same disposable schema, so files within a job must remain sequential.
    const result = Bun.spawnSync(
      [
        process.execPath,
        'test',
        '--no-orphans',
        file,
        ...(testNamePattern === undefined ? [] : ['--test-name-pattern', testNamePattern]),
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
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
