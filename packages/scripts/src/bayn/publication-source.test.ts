import { afterEach, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('./verify-publication-source.sh', import.meta.url))
const workflow = Bun.YAML.parse(
  readFileSync(new URL('../../../../.github/workflows/bayn-build-push.yml', import.meta.url), 'utf8'),
)
const directories: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-publication-source-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  const checkout = join(directory, 'checkout')
  git(directory, 'init', '--quiet', '--initial-branch=main', origin)
  git(
    origin,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'source',
  )
  git(directory, 'clone', '--quiet', '--no-local', origin, checkout)
  const sha = git(checkout, 'rev-parse', 'HEAD')
  const run = (overrides: Record<string, string> = {}) =>
    spawnSync('bash', [guard], {
      cwd: checkout,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: sha,
        BAYN_EXPECTED_MAIN_SHA: sha,
        ...overrides,
      },
    })
  const advance = () =>
    git(
      origin,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'new main',
    )
  return { checkout, run, advance }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('admits only the requested checked-out current main for recovery', () => {
  expect(fixture().run().status).toBe(0)
})

test.each([
  { GITHUB_REF: 'refs/heads/feature' },
  { GITHUB_REF: 'refs/tags/main' },
  { GITHUB_EVENT_NAME: 'pull_request' },
  { GITHUB_EVENT_NAME: 'workflow_call' },
  { GITHUB_SHA: 'main' },
  { GITHUB_SHA: '0'.repeat(40) },
  { GITHUB_SHA: 'f'.repeat(40) },
  { BAYN_EXPECTED_MAIN_SHA: '' },
  { BAYN_EXPECTED_MAIN_SHA: 'main' },
  { BAYN_EXPECTED_MAIN_SHA: 'f'.repeat(40) },
])('rejects an invalid ref, event, checkout or expected source: %j', (overrides) => {
  expect(fixture().run(overrides).status).not.toBe(0)
})

test('refuses discovery when main advances after successful admission', () => {
  const { run, advance } = fixture()
  expect(run().status).toBe(0)
  advance()
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('no longer current main')
})

test('fails closed when the current main source cannot be read', () => {
  const { checkout, run } = fixture()
  git(checkout, 'remote', 'remove', 'origin')
  expect(run().status).not.toBe(0)
})

test('preserves source-bound push publication when later main commits exist', () => {
  const { run, advance } = fixture()
  advance()
  expect(run({ GITHUB_EVENT_NAME: 'push', BAYN_EXPECTED_MAIN_SHA: '' }).status).toBe(0)
})

test('the workflow rejects a wrong ref before checkout and guards both admission and discovery', () => {
  const changes = workflow.jobs.changes.steps
  expect(changes[0].name).toBe('Require main publication ref')
  for (const ref of ['refs/heads/main', 'refs/heads/feature', 'refs/tags/main']) {
    const result = spawnSync('bash', ['-e', '-c', changes[0].run], {
      env: { ...process.env, GITHUB_REF: ref },
    })
    expect(result.status).toBe(ref === 'refs/heads/main' ? 0 : 1)
  }
  expect(changes[1].uses).toBe('actions/checkout@v5')
  const admission = changes[2]
  expect(admission.run).toBe('bash packages/scripts/src/bayn/verify-publication-source.sh')
  expect(admission.env).toEqual({ BAYN_EXPECTED_MAIN_SHA: '${{ inputs.expected_main_sha }}' })
  expect(changes[3].uses).toBe('./.github/actions/affected-inputs')
  const discovery = workflow.jobs['publish-cohort'].steps
  const publishIndex = discovery.findIndex(
    (step: { name?: string }) => step.name === 'Publish the verified cohort for Kargo',
  )
  expect(publishIndex).toBeGreaterThan(0)
  expect(discovery[publishIndex - 1].run).toBe(admission.run)
  expect(discovery[publishIndex - 1].env).toEqual(admission.env)
})

test('recovery retains every validation and immutable cohort dependency without new permissions', () => {
  expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
  expect(workflow.on.workflow_dispatch.inputs).toEqual({
    expected_main_sha: {
      description: 'Exact current main commit to validate and publish after a blocked release',
      required: true,
      type: 'string',
    },
  })
  expect(workflow.concurrency).toEqual({ group: '${{ github.workflow }}-main', 'cancel-in-progress': false })
  expect(workflow.jobs.validation).toEqual({
    needs: 'changes',
    if: "needs.changes.outputs.image == 'true'",
    uses: './.github/workflows/bayn-ci.yml',
    secrets: 'inherit',
  })
  expect(workflow.jobs['broker-feed-validation']).toEqual({
    needs: 'changes',
    if: "needs.changes.outputs.image == 'true'",
    uses: './.github/workflows/bayn-broker-feed-validation.yml',
  })
  for (const image of ['image', 'research-image', 'broker-feed-image']) {
    expect(workflow.jobs[image].needs).toEqual(['validation', 'broker-feed-validation'])
    expect(workflow.jobs[image].with.source_revision).toBe('${{ github.sha }}')
    expect(workflow.jobs[image].with.publish_on_dispatch).toBe(false)
    expect(workflow.jobs[image].with.publish_kargo_tag).toBe(false)
    expect(workflow.jobs[image].with.latest).toBe(false)
  }
  expect(workflow.jobs['publish-cohort'].needs).toEqual(['image', 'research-image', 'broker-feed-image'])
})
