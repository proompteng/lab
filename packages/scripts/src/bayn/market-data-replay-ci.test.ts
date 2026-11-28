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
  readonly outputs?: Record<string, string>
  readonly 'timeout-minutes'?: number
  readonly strategy?: {
    readonly 'fail-fast'?: boolean
    readonly matrix?: { readonly group?: readonly string[] }
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
  MERGE_GROUP: 'false',
  CHANGES_RESULT: 'success',
  BAYN_RELEVANT: 'true',
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

test('a merge group must select every Bayn suite', async () => {
  expect((await run({ MERGE_GROUP: 'true' })).exit).toBe(0)
  for (const flag of ['BAYN_RELEVANT', 'PR_CHECKS_RELEVANT', 'FORMAL_RELEVANT', 'GEPA_RELEVANT']) {
    const failed = await run({ MERGE_GROUP: 'true', [flag]: 'false' })
    expect(failed.exit).toBe(1)
    expect(failed.stderr).toContain('Merge group validation must select every Bayn check.')
  }
})

test('contract-only changes still require the existing Bayn release gate and PR checks', async () => {
  expect(required.name).toBe('Bayn release gate')
  expect(required.if).toBe('always()')
  expect(required.needs).toContain('pr-checks')
  expect(workflow.jobs.changes?.outputs?.pr_checks).toBe(
    "${{ github.event_name != 'pull_request' && steps.manual.outputs.bayn || fromJSON(steps.filter.outputs.affected).bayn || fromJSON(steps.filter.outputs.affected).contracts }}",
  )
  expect(workflow.jobs['pr-checks']?.if).toBe("needs.changes.outputs.pr_checks == 'true'")
  expect(gate.env?.PR_CHECKS_RELEVANT).toBe('${{ needs.changes.outputs.pr_checks }}')
  expect(gate.env?.PR_CHECKS_RESULT).toBe('${{ needs.pr-checks.result }}')
  const applicable = { ...skippedRuntime, BAYN_RELEVANT: 'false' }
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
  expect(replay.if).toBe("needs.changes.outputs.bayn == 'true'")
  expect(replay.needs).toBe('changes')
  expect(replay['timeout-minutes']).toBeLessThanOrEqual(15)
  expect(required.needs).toContain('market-data-replay')
  expect(gate.env?.MARKET_DATA_REPLAY_RESULT).toBe('${{ needs.market-data-replay.result }}')
  expect(required.needs).toContain('gepa')
  expect(gate.env?.GEPA_RESULT).toBe('${{ needs.gepa.result }}')
  for (const [job, result] of [
    ['unit-tests', 'UNIT_RESULT'],
    ['archive-integration', 'ARCHIVE_RESULT'],
    ['ledger-integration', 'LEDGER_RESULT'],
    ['postgres-integration', 'POSTGRES_RESULT'],
    ['formal-verification', 'FORMAL_RESULT'],
    ['replay-execution-observer', 'REPLAY_EXECUTION_RESULT'],
    ['streaming-integration', 'STREAMING_INTEGRATION_RESULT'],
  ] as const) {
    expect(required.needs).toContain(job)
    expect(gate.env?.[result]).toBe(`\${{ needs.${job}.result }}`)
  }
})

test('streaming failure suites have an isolated required job in exact-revision validation', () => {
  const streaming = workflow.jobs['streaming-integration']
  expect(streaming?.if).toBe("needs.changes.outputs.bayn == 'true'")
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
  const irrelevant = {
    ...skippedRuntime,
    BAYN_RELEVANT: 'false',
    PR_CHECKS_RELEVANT: 'false',
    PR_CHECKS_RESULT: 'skipped',
    FORMAL_RELEVANT: 'false',
    FORMAL_RESULT: 'skipped',
    GEPA_RELEVANT: 'false',
    GEPA_RESULT: 'skipped',
  }
  expect((await run(irrelevant)).exit).toBe(0)
  expect((await run({ ...irrelevant, CHANGES_RESULT: 'failure' })).exit).not.toBe(0)
  expect((await run({ ...irrelevant, PR_CHECKS_RELEVANT: '' })).exit).not.toBe(0)
  expect((await run({ ...irrelevant, LEDGER_RESULT: 'failure' })).exit).not.toBe(0)
})

test('unchanged Python inputs may skip GEPA independently of service validation', async () => {
  expect((await run({ GEPA_RELEVANT: 'false', GEPA_RESULT: 'skipped' })).exit).toBe(0)
  expect((await run({ BAYN_RELEVANT: 'false', GEPA_RESULT: 'failure' })).exit).not.toBe(0)
})

test('formal-only changes require a successful proof result independently of service jobs', async () => {
  const noRuntime = { ...skippedRuntime, BAYN_RELEVANT: 'false' }
  expect((await run({ ...noRuntime, FORMAL_RESULT: 'success' })).exit).toBe(0)
  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    const result = await run({ ...noRuntime, FORMAL_RESULT: outcome })
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain('FORMAL_RESULT must be success')
  }
  expect((await run({ FORMAL_RELEVANT: 'false', FORMAL_RESULT: 'skipped' })).exit).toBe(0)
})
