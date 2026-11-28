import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

interface WorkflowJob {
  readonly name?: string
  readonly if?: string
  readonly uses?: string
  readonly needs?: readonly string[] | string
  readonly with?: Record<string, string>
  readonly 'timeout-minutes'?: number
  readonly strategy?: {
    readonly 'fail-fast'?: boolean
    readonly matrix?: { readonly group?: readonly string[]; readonly shard?: readonly number[] }
  }
  readonly steps: readonly { readonly name?: string; readonly run?: string; readonly env?: Record<string, string> }[]
}
const workflow = YAML.parse(
  readFileSync(join(import.meta.dir, '../../../../.github/workflows/bayn-ci.yml'), 'utf8'),
) as {
  readonly on: Record<string, unknown>
  readonly jobs: Record<string, WorkflowJob>
}
const required = workflow.jobs.required
const replay = workflow.jobs['market-data-replay']
if (required === undefined || replay === undefined) throw new Error('Missing market-data replay release gates')
const gate = required.steps.find((step) => step.name === 'Require every applicable Bayn release check')
if (gate?.run === undefined) throw new Error('Missing executable release gate')
const command = gate.run

test('the root gate requires the complete Bayn workflow on queued revisions', () => {
  const router = YAML.parse(
    readFileSync(join(import.meta.dir, '../../../../.github/workflows/pull-request.yml'), 'utf8'),
  ) as { readonly jobs: Record<string, WorkflowJob> }
  const bayn = router.jobs.bayn
  expect(bayn?.uses).toBe('./.github/workflows/bayn-ci.yml')
  expect(bayn?.if).toBe("github.event_name == 'merge_group'")
  expect(bayn?.needs).toBeUndefined()
  expect(Object.keys(workflow.on)).toEqual(['pull_request', 'workflow_dispatch', 'workflow_call'])

  const required = router.jobs['ci-pr']
  expect(required?.needs).toContain('bayn')
  const enforcement = required?.steps.find((step) => step.name === 'Enforce selected validation results')
  expect(enforcement?.env?.BAYN_RESULT).toBe('${{ needs.bayn.result }}')
  if (!enforcement?.run) throw new Error('Missing root validation command')
  for (const [full, baynResult, exitCode] of [
    ['false', 'skipped', 0],
    ['true', 'success', 0],
    ['true', 'skipped', 1],
    ['true', 'cancelled', 1],
    ['true', 'failure', 1],
  ] as const) {
    const result = Bun.spawnSync(['bash', '-c', enforcement.run], {
      env: {
        PATH: process.env.PATH ?? '',
        PLAN_RESULT: 'success',
        VALIDATE_RESULT: 'success',
        VALIDATE_EXPECTED: 'success',
        LANDING_RESULT: 'success',
        LANDING_EXPECTED: 'success',
        AGENTS_RESULT: 'success',
        BAYN_RESULT: baynResult,
        OFZ_RESULT: 'success',
        RELAY_RESULT: 'success',
        TENGRI_RESULT: 'success',
        BUF_RESULT: 'success',
        SCRIPTS_RESULT: 'success',
        TORGHUT_RESULT: 'success',
        TORGHUT_SCHEMA_RESULT: 'success',
        TORGHUT_NOTEBOOKS_RESULT: 'success',
        QUEUE_SERVICES_RESULT: 'success',
        FULL_VALIDATION: full,
        DELEGATED: '[]',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(exitCode)
  }
})

const successful = {
  PATH: process.env.PATH ?? '',
  EXACT_REVISION: 'false',
  CHANGES_RESULT: 'success',
  FULL_RELEVANT: 'true',
  FAST_RELEVANT: 'false',
  FAST_RESULT: 'skipped',
  PR_CHECKS_RELEVANT: 'true',
  PR_CHECKS_RESULT: 'success',
  FORMAL_RELEVANT: 'true',
  FORMAL_RESULT: 'success',
  GEPA_RELEVANT: 'true',
  GEPA_RESULT: 'success',
  UNIT_RESULT: 'success',
  ARCHIVE_RESULT: 'success',
  LEDGER_RESULT: 'success',
  POSTGRES_RESULT: 'success',
  MARKET_DATA_REPLAY_RESULT: 'success',
  STREAMING_INTEGRATION_RESULT: 'success',
  REPLAY_EXECUTION_RESULT: 'success',
}
const skippedRuntime = Object.fromEntries(
  [
    'UNIT_RESULT',
    'ARCHIVE_RESULT',
    'LEDGER_RESULT',
    'POSTGRES_RESULT',
    'MARKET_DATA_REPLAY_RESULT',
    'STREAMING_INTEGRATION_RESULT',
    'REPLAY_EXECUTION_RESULT',
  ].map((name) => [name, 'skipped']),
)
const noChecks = {
  ...skippedRuntime,
  FULL_RELEVANT: 'false',
  PR_CHECKS_RELEVANT: 'false',
  PR_CHECKS_RESULT: 'skipped',
  FORMAL_RELEVANT: 'false',
  FORMAL_RESULT: 'skipped',
  GEPA_RELEVANT: 'false',
  GEPA_RESULT: 'skipped',
}
const run = async (overrides: Record<string, string>) => {
  const child = Bun.spawn(['bash', '-c', command], {
    env: { ...successful, ...overrides },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

test('exact-revision callers must select full validation', async () => {
  expect(gate.env?.EXACT_REVISION).toBe("${{ github.event_name != 'pull_request' }}")
  expect((await run({ EXACT_REVISION: 'true' })).exit).toBe(0)
  const failed = await run({ ...noChecks, EXACT_REVISION: 'true' })
  expect(failed.exit).toBe(1)
  expect(failed.stderr).toContain('Exact-revision validation requires the full Bayn tier.')
})

test('the full tier must select every full check and cannot select the fast tier', async () => {
  for (const [flag, value] of [
    ['FAST_RELEVANT', 'true'],
    ['PR_CHECKS_RELEVANT', 'false'],
    ['FORMAL_RELEVANT', 'false'],
    ['GEPA_RELEVANT', 'false'],
  ] as const) {
    const failed = await run({ [flag]: value })
    expect(failed.exit).toBe(1)
    expect(failed.stderr).toContain('The full Bayn tier must select every full-tier check')
  }
})

test('fast-only changes require successful offline checks under the existing Bayn release gate', async () => {
  expect(required.name).toBe('Bayn release gate')
  expect(required.if).toBe('always()')
  expect(required.needs).toContain('fast-checks')
  expect(gate.env?.FAST_RELEVANT).toBe('${{ needs.changes.outputs.fast }}')
  expect(gate.env?.FAST_RESULT).toBe('${{ needs.fast-checks.result }}')
  const fast = workflow.jobs['fast-checks']
  expect(fast?.needs).toBe('changes')
  expect(fast?.if).toBe("needs.changes.outputs.fast == 'true'")
  expect(fast?.uses).toBe('./.github/workflows/common-monorepo.yml')
  expect(fast?.with).toMatchObject({
    'bun-version': '1.4.3',
    'working-directory': 'services/bayn',
    'lint-command': 'bun run lint',
    'oxlint-command': 'bun run lint:oxlint',
    'oxlint-type-command': 'bun run lint:oxlint:type',
  })
  expect(fast?.with?.['test-command']).toContain('bun run tsc')
  expect(fast?.with?.['test-command']).toContain('bun test ./tools')
  expect(fast?.with?.['test-command']).toContain('--parallel=2')
  expect(fast?.with?.['build-command']).toBeUndefined()
  const applicable = { ...noChecks, FAST_RELEVANT: 'true', FAST_RESULT: 'success' }
  expect((await run(applicable)).exit).toBe(0)
  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    const failed = await run({ ...applicable, FAST_RESULT: outcome })
    expect(failed.exit).toBe(1)
    expect(failed.stderr).toContain('FAST_RESULT must be success')
  }
  expect((await run({ ...applicable, FORMAL_RELEVANT: 'true' })).exit).toBe(1)
  expect((await run({ ...applicable, POSTGRES_RESULT: 'failure' })).exit).toBe(1)
})

test('contract-only changes still require successful PR checks', async () => {
  expect(required.needs).toContain('pr-checks')
  expect(workflow.jobs['pr-checks']?.if).toBe("needs.changes.outputs.pr_checks == 'true'")
  expect(gate.env?.PR_CHECKS_RELEVANT).toBe('${{ needs.changes.outputs.pr_checks }}')
  expect(gate.env?.PR_CHECKS_RESULT).toBe('${{ needs.pr-checks.result }}')
  const applicable = { ...noChecks, PR_CHECKS_RELEVANT: 'true', PR_CHECKS_RESULT: 'success' }
  expect((await run(applicable)).exit).toBe(0)
  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    const failed = await run({ ...applicable, PR_CHECKS_RESULT: outcome })
    expect(failed.exit).toBe(1)
    expect(failed.stderr).toContain('PR_CHECKS_RESULT must be success')
  }
})

test('native replay cases run in isolated required groups without extending their job budget', () => {
  const ledger = workflow.jobs['ledger-integration']
  expect(ledger?.strategy?.matrix?.group).toEqual([
    'runtime',
    'backtest',
    'latency-jev',
    'latency-ablation',
    'latency-momentum',
    'latency-momentum-trading',
    'frozen-control',
    'restart',
    'inference',
  ])
  expect(ledger?.strategy?.['fail-fast']).toBe(false)
  expect(ledger?.['timeout-minutes']).toBe(15)
  expect(
    ledger?.steps.find((step) => step.name === 'Verify replay accounting with PostgreSQL and TigerBeetle')?.run,
  ).toBe('bun run --cwd services/bayn test:ledger ${{ matrix.group }}')
  expect(required.needs).toContain('ledger-integration')
  expect(gate.env?.LEDGER_RESULT).toBe('${{ needs.ledger-integration.result }}')
})

test.each([
  { script: 'test-market-data-replay.sh', mode: 'kafka', removed: ['a'.repeat(64)] },
  { script: 'test-market-data-replay.sh', mode: 'restate', removed: ['a'.repeat(64), 'b'.repeat(64)] },
  { script: 'test-market-data-replay.sh', mode: 'foreign', removed: [] },
  { script: 'test-streaming-integrations.sh', mode: 'postgres', removed: ['c'.repeat(64)] },
  { script: 'test-streaming-integrations.sh', mode: 'restate', removed: ['c'.repeat(64), 'b'.repeat(64)] },
  { script: 'test-streaming-integrations.sh', mode: 'foreign', removed: [] },
])(
  '$script created-but-failed $mode fixture removes only verified job-owned container IDs',
  async ({ script, mode, removed: expectedRemoved }) => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-replay-cleanup-'))
    try {
      await writeFile(
        join(directory, 'docker'),
        `#!/usr/bin/env bash
set -eu
command=$1
shift
case "$command" in
  pull|logs|exec) exit 0 ;;
  port) printf '127.0.0.1:15432\\n' ;;
  run)
    name= owner=
    while (( $# > 0 )); do
      case "$1" in
        --name) name=$2; shift 2 ;;
        --label) owner=$(printf '%s' "$2" | cut -d= -f2); shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$name" == *-kafka-* ]]; then id=$(printf 'a%.0s' {1..64});
    elif [[ "$name" == *-postgres-* ]]; then id=$(printf 'c%.0s' {1..64});
    else id=$(printf 'b%.0s' {1..64}); fi
    if [[ "$BAYN_FAKE_DOCKER_MODE" == foreign ]]; then owner=another-run; fi
    printf '%s %s\\n' "$id" "$owner" > "$BAYN_FAKE_DOCKER_STATE/$name"
    if [[ "$BAYN_FAKE_DOCKER_MODE" != restate || "$name" == *-restate-* ]]; then exit 125; fi
    printf '%s\\n' "$id"
    ;;
  inspect) cat "$BAYN_FAKE_DOCKER_STATE/\${!#}" ;;
  rm) printf '%s\\n' "\${!#}" >> "$BAYN_FAKE_DOCKER_STATE/removed" ;;
  *) exit 99 ;;
esac
`,
        { mode: 0o755 },
      )
      await writeFile(join(directory, 'removed'), '')
      const root = join(import.meta.dir, '../../../..')
      const child = Bun.spawn(['bash', join(root, 'services/bayn/scripts', script)], {
        cwd: root,
        env: {
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          BAYN_FAKE_DOCKER_STATE: directory,
          BAYN_FAKE_DOCKER_MODE: mode,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exit, stdout, stderr }).toEqual({ exit: 125, stdout: '', stderr: '' })
      const removed = (await readFile(join(directory, 'removed'), 'utf8')).trim().split('\n').filter(Boolean)
      expect(removed).toEqual(expectedRemoved)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('market-data fixture runs for Bayn changes and participates in the existing release gate', () => {
  expect(replay.needs).toBe('changes')
  expect(replay['timeout-minutes']).toBeLessThanOrEqual(15)
  for (const [job, result, selector] of [
    ['gepa', 'GEPA_RESULT', 'gepa'],
    ['formal-verification', 'FORMAL_RESULT', 'formal'],
    ['unit-tests', 'UNIT_RESULT'],
    ['archive-integration', 'ARCHIVE_RESULT'],
    ['ledger-integration', 'LEDGER_RESULT'],
    ['postgres-integration', 'POSTGRES_RESULT'],
    ['market-data-replay', 'MARKET_DATA_REPLAY_RESULT'],
    ['replay-execution-observer', 'REPLAY_EXECUTION_RESULT'],
    ['streaming-integration', 'STREAMING_INTEGRATION_RESULT'],
  ] as const) {
    expect(workflow.jobs[job]?.if).toBe(`needs.changes.outputs.${selector ?? 'full'} == 'true'`)
    expect(required.needs).toContain(job)
    expect(gate.env?.[result]).toBe(`\${{ needs.${job}.result }}`)
  }
  expect(workflow.jobs['postgres-integration']?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4])
})

test('streaming failure suites have an isolated required job in exact-revision validation', () => {
  const streaming = workflow.jobs['streaming-integration']
  expect(streaming?.needs).toBe('changes')
  expect(streaming?.['timeout-minutes']).toBeLessThanOrEqual(15)
  expect(
    streaming?.steps.find((step) => step.name === 'Verify streaming failure boundaries against disposable services')
      ?.run,
  ).toBe('timeout 12m bash services/bayn/scripts/test-streaming-integrations.sh')
  const publication = YAML.parse(
    readFileSync(join(import.meta.dir, '../../../../.github/workflows/bayn-build-push.yml'), 'utf8'),
  ) as {
    readonly jobs: { readonly validation: { readonly uses: string } }
    readonly on: { readonly push: { readonly paths: readonly string[] } }
  }
  expect(publication.jobs.validation.uses).toBe('./.github/workflows/bayn-ci.yml')
  for (const script of [
    'test-streaming-integrations.sh',
    'test_verify_integration_results.py',
    'verify-integration-results.py',
  ])
    expect(publication.on.push.paths).toContain(`!services/bayn/scripts/${script}`)
})

test.each([
  'MARKET_DATA_REPLAY_RESULT',
  'STREAMING_INTEGRATION_RESULT',
  'GEPA_RESULT',
  'UNIT_RESULT',
  'ARCHIVE_RESULT',
  'LEDGER_RESULT',
  'POSTGRES_RESULT',
  'FORMAL_RESULT',
  'REPLAY_EXECUTION_RESULT',
])('a relevant change cannot pass without successful %s', async (resultName) => {
  expect((await run({})).exit).toBe(0)
  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    const result = await run({ [resultName]: outcome })
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain(`${resultName} must be success`)
  }
})

test('irrelevant changes retain the existing skip policy but detection failures still fail', async () => {
  expect((await run(noChecks)).exit).toBe(0)
  expect((await run({ ...noChecks, CHANGES_RESULT: 'failure' })).exit).not.toBe(0)
  expect((await run({ ...noChecks, PR_CHECKS_RELEVANT: '' })).exit).not.toBe(0)
  expect((await run({ ...noChecks, FAST_RELEVANT: '' })).exit).not.toBe(0)
  expect((await run({ ...noChecks, LEDGER_RESULT: 'failure' })).exit).not.toBe(0)
})

test('GEPA changes require a successful Python result independently of service jobs', async () => {
  const gepa = { ...noChecks, GEPA_RELEVANT: 'true' }
  expect((await run({ ...gepa, GEPA_RESULT: 'success' })).exit).toBe(0)
  expect((await run({ ...gepa, GEPA_RESULT: 'failure' })).exit).toBe(1)
})

test('formal-only changes require a successful proof result independently of service jobs', async () => {
  const formal = { ...noChecks, FORMAL_RELEVANT: 'true' }
  expect((await run({ ...formal, FORMAL_RESULT: 'success' })).exit).toBe(0)
  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    const result = await run({ ...formal, FORMAL_RESULT: outcome })
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain('FORMAL_RESULT must be success')
  }
})
