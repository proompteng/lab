import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'

const service = fileURLToPath(new URL('..', import.meta.url))
if (process.argv.length !== 2) throw Error('Usage: bun run --filter @proompteng/bayn verify:tla')
const models = join(service, 'formal/tla')
const pin = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String, sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
)(JSON.parse(readFileSync(join(models, 'toolchain.json'), 'utf8')))
const cache = join(service, 'node_modules/.cache/bayn-tla')
mkdirSync(cache, { recursive: true })
const jar = join(cache, `tla2tools-${pin.version}.jar`)
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
if (!existsSync(jar)) {
  const download = mkdtempSync(join(cache, 'download-'))
  try {
    const temporaryJar = join(download, 'tla2tools.jar')
    const result = Bun.spawnSync(
      [
        'curl',
        '--fail',
        '--location',
        '--retry',
        '3',
        '--output',
        temporaryJar,
        `https://github.com/tlaplus/tlaplus/releases/download/v${pin.version}/tla2tools.jar`,
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    )
    if (result.exitCode !== 0) throw Error('Could not download the pinned TLC checker')
    if (digest(temporaryJar) !== pin.sha256) throw Error('Downloaded TLC checksum does not match toolchain.json')
    renameSync(temporaryJar, jar)
  } finally {
    rmSync(download, { recursive: true, force: true })
  }
}
if (digest(jar) !== pin.sha256) throw Error('Cached TLC checksum does not match toolchain.json')

const suppliedOutput = process.env['BAYN_TLA_OUTPUT_DIR']
const output = suppliedOutput ?? mkdtempSync(join(tmpdir(), 'bayn-tla-'))
if (suppliedOutput !== undefined && existsSync(output) && readdirSync(output).length > 0)
  throw Error('BAYN_TLA_OUTPUT_DIR must be empty to retain an isolated verification run')
mkdirSync(output, { recursive: true })
console.log(`TLC ${pin.version}; results: ${output}`)
writeFileSync(join(output, 'toolchain.json'), `${JSON.stringify(pin, null, 2)}\n`)

const check = (name: string, directory: string, expectedViolation?: string) => {
  const result = Bun.spawnSync(
    [
      'java',
      '-Xmx1g',
      '-XX:+UseParallelGC',
      '-cp',
      jar,
      'tlc2.TLC',
      '-workers',
      '1',
      '-fp',
      '0',
      '-view',
      '-metadir',
      join(directory, 'metadata'),
      '-dump',
      join(directory, name),
      '-config',
      join(directory, `${name}.cfg`),
      `${name}.tla`,
    ],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe' },
  )
  const log = result.stdout.toString() + result.stderr.toString()
  writeFileSync(join(directory, 'tlc.log'), log)
  if (expectedViolation === undefined) {
    if (result.exitCode !== 0 || !log.includes('Model checking completed. No error has been found.')) {
      console.error(log)
      throw Error(`${name} model checking failed; retained ${directory}`)
    }
    console.log(`${name}: ${log.match(/^\d+ states generated,.*$/m)?.[0] ?? 'state count missing'}`)
  } else {
    if (result.exitCode === 0 || !log.includes(expectedViolation)) {
      console.error(log)
      throw Error(`${name} did not detect the expected violation: ${expectedViolation}`)
    }
    console.log(`${name}: detected ${expectedViolation}`)
  }
}

for (const name of ['Controller', 'EntryRecovery', 'MutationLedger']) {
  const directory = join(output, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${name}.tla`), readFileSync(join(models, `${name}.tla`)))
  writeFileSync(join(directory, `${name}.cfg`), readFileSync(join(models, `${name}.cfg`)))
  check(name, directory)
}

const faults = [
  {
    model: 'Controller',
    name: 'stale-completion',
    before: 'inFlight /\\ CanComplete /\\ sequence < 2',
    after: 'inFlight /\\ sequence < 2',
    violation: 'Invariant NoStaleCommit is violated.',
  },
  {
    model: 'EntryRecovery',
    name: 'missed-short-retry',
    before: 'IF Pending THEN ContinuationDelay ELSE NormalDelay',
    after: 'NormalDelay',
    violation: 'Invariant CappedRetries is violated.',
  },
  {
    model: 'EntryRecovery',
    name: 'stopped-clock',
    before: ' /\\ WF_vars(Tick)',
    after: '',
    violation: 'Temporal properties were violated.',
  },
  {
    model: 'MutationLedger',
    name: 'duplicate-dispatch',
    before: 'Start == /\\ MayStart',
    after: 'Start == /\\ AuthorityAllowed /\\ starts < 2',
    violation: 'Invariant NoDuplicateDispatch is violated.',
  },
  {
    model: 'MutationLedger',
    name: 'unauthorized-dispatch',
    before: 'Start == /\\ MayStart',
    after: 'Start == /\\ phase = "NONE"',
    violation: 'Invariant NoUnauthorizedStart is violated.',
  },
  {
    model: 'MutationLedger',
    name: 'duplicate-posting',
    before: "postedA' = IF postedA = 0 THEN 1 ELSE postedA",
    after: "postedA' = postedA + 1",
    violation: 'Invariant NoDuplicatePosting is violated.',
  },
]
for (const fault of faults) {
  const directory = join(output, fault.name)
  mkdirSync(directory, { recursive: true })
  const original = readFileSync(join(models, `${fault.model}.tla`), 'utf8')
  if (original.split(fault.before).length !== 2)
    throw Error(`Fault injection no longer identifies one guard: ${fault.name}`)
  writeFileSync(join(directory, `${fault.model}.tla`), original.replace(fault.before, fault.after))
  writeFileSync(join(directory, `${fault.model}.cfg`), readFileSync(join(models, `${fault.model}.cfg`)))
  check(fault.model, directory, fault.violation)
}

const conformance = Bun.spawnSync([process.execPath, 'test', 'formal/conformance/tla.test.ts'], {
  cwd: service,
  env: { ...process.env, BAYN_TLA_STATE_DIRECTORY: output },
  stdout: 'inherit',
  stderr: 'inherit',
})
if (conformance.exitCode !== 0) throw Error(`TLC production conformance failed; retained ${output}`)

const productionFaults = [
  {
    name: 'stale-completion',
    file: 'src/execution/controller.ts',
    before: `  if (
    !state.active ||
    tick.epoch !== state.epoch ||
    tick.sequence !== state.nextSequence ||
    state.sourceRevision !== workerSourceRevision
  ) {`,
    after: '  if (false) {',
    test: 'controller delivery and completion guards reject stale epochs, sequences and worker sources',
  },
  {
    name: 'missed-short-retry',
    file: 'src/observe-composition/recovery-driver.ts',
    before: '        ? Math.min(1_000, normalDelayMs, expiresAt - now)',
    after: '        ? normalDelayMs',
    test: 'initial and later input retries retain the original admission, binding and consumed-window guards',
  },
  {
    name: 'duplicate-dispatch',
    file: 'src/execution/mutations/decisions.ts',
    before: "  if (existing === undefined) return Result.succeed({ _tag: 'BeginMutation' })",
    after: "  return Result.succeed({ _tag: 'BeginMutation' })",
    test: 'mutation authority, immutable start replay and every reachable outcome agree with production',
  },
  {
    name: 'unauthorized-dispatch',
    file: 'src/execution/mutations/decisions.ts',
    before: '  if (authority.maximum !== Authority.Execution) {',
    after: '  if (false) {',
    test: 'mutation authority, immutable start replay and every reachable outcome agree with production',
  },
  {
    name: 'corrupt-ledger-amount',
    file: 'src/ledger-plan/verification.ts',
    before: '  actual.amount === expected.amount &&\n',
    after: '',
    test: 'every reachable partial ledger posting uses production preflight and exact metadata verification',
  },
]
for (const fault of productionFaults) {
  const directory = join(output, `production-${fault.name}`)
  mkdirSync(directory)
  const source = join(service, fault.file)
  const originalHash = digest(source)
  const preload = join(directory, 'preload.ts')
  const marker = `BAYN_PRODUCTION_MUTATION_APPLIED:${fault.name}`
  const modulePattern = `${fault.file.replaceAll('.', '\\.')}$`
  // A child-only loader changes the real module without exposing other processes to a mutated source file.
  writeFileSync(
    preload,
    `import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
plugin({
  name: ${JSON.stringify(fault.name)},
  setup(build) {
    build.onLoad({ filter: new RegExp(${JSON.stringify(modulePattern)}) }, ({ path }) => {
      if (path !== ${JSON.stringify(source)}) throw Error('Mutation resolved a different production module')
      const before = ${JSON.stringify(fault.before)}
      const original = readFileSync(path, 'utf8')
      if (original.split(before).length !== 2) throw Error('Mutation no longer identifies one production guard')
      console.error(${JSON.stringify(marker)})
      return { contents: original.replace(before, ${JSON.stringify(fault.after)}), loader: 'ts' }
    })
  },
})
`,
  )
  const result = Bun.spawnSync(
    [
      process.execPath,
      'test',
      '--preload',
      preload,
      'formal/conformance/tla.test.ts',
      '--test-name-pattern',
      fault.test,
    ],
    {
      cwd: service,
      env: { ...process.env, NO_COLOR: '1', BAYN_TLA_STATE_DIRECTORY: output },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
  )
  const log = result.stdout.toString() + result.stderr.toString()
  writeFileSync(join(directory, 'test.log'), log)
  if (digest(source) !== originalHash) throw Error(`Production source changed during ${fault.name}`)
  if (
    result.exitCode !== 1 ||
    log.split(marker).length !== 2 ||
    !log.includes(`(fail) TLC reachable states conform to production > ${fault.test}`) ||
    !log.includes('error: expect(received).toBe(expected)')
  ) {
    console.error(log)
    throw Error(`Production conformance did not detect ${fault.name}; retained ${directory}`)
  }
  writeFileSync(
    join(directory, 'source.json'),
    `${JSON.stringify({ file: fault.file, sha256: originalHash, test: fault.test }, null, 2)}\n`,
  )
  console.log(`${fault.name}: production conformance rejected the injected defect`)
}
if (suppliedOutput === undefined) rmSync(output, { recursive: true, force: true })
