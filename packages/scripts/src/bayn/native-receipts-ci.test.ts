import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

interface WorkflowJob {
  readonly if?: string
  readonly needs?: readonly string[] | string
  readonly 'timeout-minutes'?: number
  readonly steps: readonly { readonly name?: string; readonly run?: string; readonly env?: Record<string, string> }[]
}
const workflow = YAML.parse(
  readFileSync(join(import.meta.dir, '../../../../.github/workflows/bayn-ci.yml'), 'utf8'),
) as {
  readonly jobs: Record<string, WorkflowJob>
}
const required = workflow.jobs.required
const native = workflow.jobs['native-receipts']
if (required === undefined || native === undefined) throw new Error('Missing native receipt release gates')
const gate = required.steps.find((step) => step.name === 'Require every applicable Bayn release check')
if (gate?.run === undefined) throw new Error('Missing executable release gate')
const command = gate.run
const successful = {
  PATH: process.env.PATH ?? '',
  CHANGES_RESULT: 'success',
  BAYN_RELEVANT: 'true',
  IMAGE_RELEVANT: 'false',
  PR_CHECKS_RESULT: 'success',
  EFFECT_RESULT: 'success',
  BROKER_RESULT: 'success',
  POSTGRES_RESULT: 'success',
  NATIVE_RECEIPTS_RESULT: 'success',
  DEPENDENCY_INPUT_RESULT: 'success',
  IMAGE_RESULT: 'skipped',
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

test.each(['kafka', 'restate', 'foreign', 'cleanup'] as const)(
  '%s fixture cleanup preserves failure status and removes only verified job-owned container IDs',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-native-cleanup-'))
    try {
      await writeFile(
        join(directory, 'docker'),
        `#!/usr/bin/env bash
set -eu
command=$1
shift
case "$command" in
  pull) exit 0 ;;
  logs) if [[ "$BAYN_FAKE_DOCKER_MODE" == cleanup ]]; then echo 'Kafka Server started'; fi; exit 0 ;;
  run)
    name= owner=
    while (( $# > 0 )); do
      case "$1" in
        --name) name=$2; shift 2 ;;
        --label) owner=$(printf '%s' "$2" | cut -d= -f2); shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$name" == *-kafka-* ]]; then id=$(printf 'a%.0s' {1..64}); else id=$(printf 'b%.0s' {1..64}); fi
    if [[ "$BAYN_FAKE_DOCKER_MODE" == foreign ]]; then owner=another-run; fi
    printf '%s %s\\n' "$id" "$owner" > "$BAYN_FAKE_DOCKER_STATE/$name"
    if [[ "$BAYN_FAKE_DOCKER_MODE" != cleanup && ( "$BAYN_FAKE_DOCKER_MODE" != restate || "$name" == *-restate-* ) ]]; then exit 125; fi
    printf '%s\\n' "$id"
    ;;
  inspect)
    if [[ "$BAYN_FAKE_DOCKER_MODE" == cleanup && "\${!#}" == *-restate-* ]]; then exit 55; fi
    cat "$BAYN_FAKE_DOCKER_STATE/\${!#}"
    ;;
  rm) printf '%s\\n' "\${!#}" >> "$BAYN_FAKE_DOCKER_STATE/removed" ;;
  *) exit 99 ;;
esac
`,
        { mode: 0o755 },
      )
      await writeFile(join(directory, 'removed'), '')
      if (mode === 'cleanup') {
        for (const executable of ['bun', 'curl'])
          await writeFile(join(directory, executable), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
        await writeFile(
          join(directory, 'node'),
          '#!/usr/bin/env bash\nif [[ "$1" == *kafka-receipts-native-node.js ]]; then exit 0; fi\nexec "$BAYN_FAKE_REAL_NODE" "$@"\n',
          { mode: 0o755 },
        )
      }
      const root = join(import.meta.dir, '../../../..')
      const child = Bun.spawn(['bash', join(root, 'services/bayn/scripts/test-native-receipts.sh')], {
        cwd: root,
        env: {
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          BAYN_FAKE_DOCKER_STATE: directory,
          BAYN_FAKE_DOCKER_MODE: mode,
          BAYN_FAKE_REAL_NODE: Bun.which('node') ?? '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exit).toBe(mode === 'cleanup' ? 1 : 125)
      if (mode === 'foreign') {
        expect(stderr).toContain('Fixture cleanup refused unowned container bayn-receipts-kafka-')
        expect(stderr).not.toContain('restate')
      } else if (mode === 'cleanup') {
        expect(stderr).toContain('Fixture cleanup could not inspect bayn-receipts-restate-')
      } else expect(stderr).toBe('')
      const removed = (await readFile(join(directory, 'removed'), 'utf8')).trim().split('\n').filter(Boolean)
      expect(removed).toEqual(
        mode === 'foreign' ? [] : mode === 'restate' ? ['a'.repeat(64), 'b'.repeat(64)] : ['a'.repeat(64)],
      )
      expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(removed.length)
      for (const id of removed) expect(stdout).toContain(`(${id})`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('native fixture runs for Bayn changes and participates in the existing release gate', () => {
  expect(native.if).toBe("needs.changes.outputs.bayn == 'true'")
  expect(native.needs).toBe('changes')
  expect(native['timeout-minutes']).toBeLessThanOrEqual(15)
  expect(required.needs).toContain('native-receipts')
  expect(gate.env?.NATIVE_RECEIPTS_RESULT).toBe('${{ needs.native-receipts.result }}')
})

test('a relevant change cannot pass without successful native receipt acceptance', async () => {
  expect((await run({})).exit).toBe(0)
  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    const result = await run({ NATIVE_RECEIPTS_RESULT: outcome })
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain('NATIVE_RECEIPTS_RESULT must be success')
  }
})

test('irrelevant changes retain the existing skip policy but detection and required image failures still fail', async () => {
  expect((await run({ BAYN_RELEVANT: 'false', NATIVE_RECEIPTS_RESULT: 'skipped' })).exit).toBe(0)
  expect((await run({ BAYN_RELEVANT: 'false', CHANGES_RESULT: 'failure' })).exit).not.toBe(0)
  expect((await run({ IMAGE_RELEVANT: 'true', IMAGE_RESULT: 'failure' })).exit).not.toBe(0)
})
