import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { compileFrozenControl } from './compile-frozen-control'
import { frozenControlSource, readFrozenControlGitSource, frozenControlSourceRevision } from './frozen-control-source'
import { sha256 } from '../src/hash'

const repository = resolve(import.meta.dir, '../../..')
const postgres = process.env['BAYN_TEST_POSTGRES_URL']
const tigerbeetle = process.env['BAYN_TEST_TIGERBEETLE_ADDRESS']
if (
  Bun.version !== '1.4.2' ||
  postgres === undefined ||
  tigerbeetle === undefined ||
  !/\/[^/?]+_test$/.test(postgres) ||
  !/^127\.0\.0\.1:\d+$/.test(tigerbeetle)
)
  throw Error(
    'Frozen control acceptance requires pinned Bun and explicitly isolated local PostgreSQL/TigerBeetle targets',
  )
const connection = new URL(postgres)
if (
  !['postgres:', 'postgresql:'].includes(connection.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) ||
  connection.search !== '' ||
  connection.hash !== ''
)
  throw Error('Frozen control acceptance cannot reset a nonlocal PostgreSQL schema')
const run = (
  command: readonly string[],
  options: {
    cwd?: string
    stdout?: 'inherit' | 'ignore' | number
    stderr?: 'inherit' | 'ignore' | number
    env?: Record<string, string | undefined>
  } = {},
) => {
  const child = Bun.spawnSync([...command], {
    cwd: repository,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    ...options,
  })
  if (child.exitCode !== 0) throw Error(`Frozen control acceptance command failed: ${command[0]} ${command[1]}`)
}
if (
  Bun.spawnSync(['git', 'cat-file', '-e', `${frozenControlSourceRevision}^{commit}`], {
    cwd: repository,
    stdin: 'ignore',
    stderr: 'ignore',
  }).exitCode !== 0
)
  run(['git', 'fetch', '--no-tags', '--depth=1', 'https://github.com/proompteng/lab.git', frozenControlSourceRevision])
const original = readFrozenControlGitSource(repository)
const temporary = mkdtempSync(join(tmpdir(), 'bayn-frozen-control-test-'))
try {
  const deps = join(temporary, 'dependencies')
  mkdirSync(deps)
  const paths = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', frozenControlSourceRevision], {
    cwd: repository,
    stdin: 'ignore',
    stderr: 'pipe',
  })
  if (paths.exitCode !== 0) throw Error('Cannot enumerate immutable dependency inputs')
  for (const path of paths.stdout.toString().trim().split('\n')) {
    if (
      !(
        ['package.json', 'bun.lock', 'bunfig.toml', '.npmrc'].includes(path) ||
        path.endsWith('/package.json') ||
        path.startsWith('patches/')
      )
    )
      continue
    const bytes = Bun.spawnSync(['git', 'show', `${frozenControlSourceRevision}:${path}`], {
      cwd: repository,
      stdin: 'ignore',
      stderr: 'pipe',
    })
    if (bytes.exitCode !== 0) throw Error('Cannot read immutable dependency input')
    const target = join(deps, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes.stdout)
  }
  run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts', '--filter', '@proompteng/bayn'], {
    cwd: deps,
  })
  const service = join(deps, 'services/bayn')
  const scenarioPath = 'services/bayn/frozen-control-scenario.ts'
  const fixture = frozenControlSource({
    dependenciesDirectory: service,
    paths: new Set([...original.paths, scenarioPath]),
    read: (path) =>
      path === scenarioPath
        ? readFileSync(join(repository, 'services/bayn/tools/fixtures/frozen-control-scenario.ts.txt'))
        : original.read(path),
  })
  const scenario = await Bun.build({
    root: repository,
    entrypoints: [fixture.entrypoint(scenarioPath)],
    target: 'node',
    plugins: [fixture.plugin],
  })
  if (!scenario.success || scenario.outputs.length !== 1 || scenario.outputs[0] === undefined)
    throw Error(JSON.stringify(scenario.logs))
  fixture.verify()
  const scenarioCommand = join(service, 'scenario.mjs')
  writeFileSync(scenarioCommand, new Uint8Array(await scenario.outputs[0].arrayBuffer()))
  const directory = join(temporary, 'scenario')
  run(['node', scenarioCommand, directory, '20'])
  const prepared = await Bun.build({
    entrypoints: [join(repository, 'services/bayn/tools/frozen-control-scenario.test-support.ts')],
    target: 'node',
    external: ['@platformatic/kafka', 'tigerbeetle-node'],
  })
  if (!prepared.success || prepared.outputs.length !== 1 || prepared.outputs[0] === undefined)
    throw Error(JSON.stringify(prepared.logs))
  const preparationCommand = join(service, 'preparation.mjs')
  writeFileSync(preparationCommand, new Uint8Array(await prepared.outputs[0].arrayBuffer()))
  run(['node', preparationCommand, 'prepare', directory])
  const command = join(service, 'frozen-control-command.mjs')
  await compileFrozenControl({
    source: original,
    dependenciesDirectory: service,
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    output: command,
  })
  // This suite exclusively owns the explicitly supplied test schema, as do the preceding ledger fixtures.
  run(
    [
      'psql',
      postgres,
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
    ],
    { stdout: 'ignore' },
  )
  const log = join(temporary, 'execution.log')
  const fd = openSync(log, 'w')
  try {
    run(
      [
        'node',
        command,
        '--input',
        join(directory, 'registered-input.json'),
        '--arrivals',
        join(directory, 'arrivals.ndjson.gz'),
        '--source-receipt',
        join(directory, 'capture.json'),
        '--source-receipt-sha256',
        sha256(readFileSync(join(directory, 'capture.json'))),
        '--output',
        join(directory, 'output'),
      ],
      {
        stdout: fd,
        stderr: fd,
        env: {
          PATH: process.env['PATH'] ?? '',
          TMPDIR: temporary,
          BAYN_BACKTEST_POSTGRES_URL: postgres,
          BAYN_BACKTEST_TIGERBEETLE_ADDRESS: tigerbeetle,
          BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID: '20912',
          BAYN_BACKTEST_TIGERBEETLE_LEDGER: '70912',
        },
      },
    )
  } catch (cause) {
    process.stderr.write(readFileSync(log, 'utf8').slice(-4096))
    throw cause
  } finally {
    closeSync(fd)
  }
  run(['node', preparationCommand, 'verify', directory])
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
