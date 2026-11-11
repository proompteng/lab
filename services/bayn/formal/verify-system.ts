import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkProductionFaults, type ProductionFault } from './production-faults'

const service = fileURLToPath(new URL('..', import.meta.url))
if (process.argv.length !== 2) throw Error('Usage: bun run --filter @proompteng/bayn verify:system')
const postgresUrl = process.env['BAYN_TEST_POSTGRES_URL']
if (postgresUrl === undefined || postgresUrl.trim() === '')
  throw Error('BAYN_TEST_POSTGRES_URL must name a disposable PostgreSQL database for execution-boundary verification')

const suppliedOutput = process.env['BAYN_SYSTEM_OUTPUT_DIR']
const output = suppliedOutput ?? mkdtempSync(join(tmpdir(), 'bayn-system-'))
if (suppliedOutput !== undefined && existsSync(output) && readdirSync(output).length > 0)
  throw Error('BAYN_SYSTEM_OUTPUT_DIR must be empty to retain an isolated verification run')
mkdirSync(output, { recursive: true })
console.log(`Bayn system verification; results: ${output}`)

const run = (name: string, args: readonly string[]) => {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: service,
    env: { ...process.env, NO_COLOR: '1', BAYN_TLA_OUTPUT_DIR: join(output, 'tla') },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 300_000,
  })
  const log = result.stdout.toString() + result.stderr.toString()
  writeFileSync(join(output, `${name}.log`), log)
  if (result.exitCode !== 0) {
    console.error(log)
    throw Error(`${name} failed; retained ${output}`)
  }
  return log
}

run('tla', ['formal/verify-tla.ts'])
console.log('Pinned TLC, checked-state conformance and existing production fault controls passed')

const retainedPolicyTest = 'source-approved registration retains PAPER material and rejects unapproved limits'
const hiddenAcceptanceTest = 'execution boundary contains hidden acceptance across replay and not-found recovery'
const ambientAdmissionTest = 'execution boundary forbids an ambient transaction from reaching the broker'
const postTransmitTest = 'keeps a post-transmit transaction failure unknown for broker recovery'
const finalAuthorizationTest = 'rejects revoked final submit authorization before broker transmission'
const cacheTest = 'unknown mutations, incomplete accounting and generation changes invalidate the cache'

const cacheVersionTest = 'execution boundary invalidates a cached observation for another intent start'
const cacheVersionTests = [-1, 0, 1].map((offset) => `${cacheVersionTest} at cut ${offset} ms`)
const competingReplayTest = 'execution boundary sends once when competing workers read the same approved intent'

const checks = [
  {
    name: 'retained-policy',
    file: 'formal/conformance/lean.test.ts',
    tests: [retainedPolicyTest],
  },
  {
    name: 'execution-boundary',
    file: 'src/system-assessment/postgres.integration.test.ts',
    tests: [hiddenAcceptanceTest, ambientAdmissionTest, ...cacheVersionTests, competingReplayTest],
  },
  {
    name: 'final-transmission',
    file: 'src/execution/runtime-program.test.ts',
    tests: [postTransmitTest, finalAuthorizationTest],
  },
  {
    name: 'broker-cache',
    file: 'src/execution/broker-state-cache.test.ts',
    tests: [cacheTest],
  },
]
const checkCases = (prefix: string) => {
  for (const check of checks) {
    const log = run(`${prefix}-${check.name}`, ['test', check.file, '--test-name-pattern', check.tests.join('|')])
    const passed = log.split('\n').filter((line) => line.startsWith('(pass) '))
    for (const test of check.tests)
      if (!passed.some((line) => line.includes(test)))
        throw Error(`${check.name} did not execute ${test}; retained ${output}`)
    console.log(`${prefix}-${check.name}: ${check.tests.length} required checks passed`)
  }
}
checkCases('baseline')

const faults: readonly ProductionFault[] = [
  {
    name: 'missing-retained-paper',
    file: 'src/execution/risk-policy.ts',
    before: '      retainedPaperRiskPolicy(accountId, allowedSymbols),\n',
    after: '',
    test: retainedPolicyTest,
    testFile: 'formal/conformance/lean.test.ts',
  },
  {
    name: 'unapproved-registration',
    file: 'src/system-assessment/policy.ts',
    before: '    if (!approvedHashes.includes(policy.riskPolicyHash))\n',
    after: '    if (false)\n',
    test: retainedPolicyTest,
    testFile: 'formal/conformance/lean.test.ts',
  },
  {
    name: 'ambient-mutation-admission',
    file: 'src/execution/mutations/postgres/start.ts',
    before: '          if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))\n',
    after: '          if (false)\n',
    test: ambientAdmissionTest,
    testFile: 'src/system-assessment/postgres.integration.test.ts',
  },
  {
    name: 'uncontained-second-intent',
    file: 'src/execution/mutations/postgres/start.ts',
    before: "              'RECOVERY_NOT_FOUND',\n",
    after: '',
    test: hiddenAcceptanceTest,
    testFile: 'src/system-assessment/postgres.integration.test.ts',
  },
  {
    name: 'stale-submit-cache',
    file: 'src/db/reconciliation.ts',
    before: "          AND NOT (mutation.intent_id = ${intentId} AND mutation.event_type = 'SUBMIT_STARTED')\n",
    after: '          AND FALSE\n',
    test: `${cacheVersionTest} at cut 0 ms`,
    testFile: 'src/system-assessment/postgres.integration.test.ts',
  },
  {
    name: 'competing-submit-replay',
    file: 'src/execution/coordinator.ts',
    before: '      if (!started.started) return Effect.succeed(started.event)\n',
    after: '',
    test: competingReplayTest,
    testFile: 'src/system-assessment/postgres.integration.test.ts',
  },
  {
    name: 'missing-final-submit-authorization',
    file: 'src/execution/runtime-program.ts',
    before: '        yield* dependencies.mutationStore.authorizeSubmit(intent.intentId, closeOnly)\n',
    after: '',
    test: finalAuthorizationTest,
    testFile: 'src/execution/runtime-program.test.ts',
  },
  {
    name: 'known-post-transmit-failure',
    file: 'src/execution/runtime-program.ts',
    before: '            transmissionStarted && cause instanceof WriterFenceError\n',
    after: '            false\n',
    test: postTransmitTest,
    testFile: 'src/execution/runtime-program.test.ts',
  },
  {
    name: 'cache-with-unknown-mutation',
    file: 'src/execution/broker-state-cache.ts',
    before: '          result.riskContext.unknownMutationCount !== 0 ||\n',
    after: '',
    test: cacheTest,
    testFile: 'src/execution/broker-state-cache.test.ts',
  },
]
checkProductionFaults(faults, service, output, process.env)
checkCases('restored')
console.log('Bayn system verification passed; unchanged production baseline passed again after fault controls')
if (suppliedOutput === undefined) rmSync(output, { recursive: true, force: true })
