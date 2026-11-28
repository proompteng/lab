import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const workflowFile = '.github/workflows/bayn-build-push.yml'
const workflowText = readFileSync(join(root, workflowFile), 'utf8')
const workflow = Bun.YAML.parse(workflowText)
const api = 'repos/proompteng/lab/actions'

const lockfile = (unrelatedVersion: string, baynIntegrity = 'bayn-client-integrity') =>
  JSON.stringify({
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'root' },
      'services/bayn': { name: 'bayn', dependencies: { client: '1.0.0' } },
      'apps/froussard': { name: 'froussard', dependencies: { unrelated: unrelatedVersion } },
    },
    packages: {
      client: ['client@1.0.0', '', {}, baynIntegrity],
      unrelated: [`unrelated@${unrelatedVersion}`, '', {}, `unrelated-integrity-${unrelatedVersion}`],
    },
  })

test('one pending Bayn release can be replaced without cancelling an active publisher', () => {
  expect(workflow.concurrency.queue).toBeUndefined()
  expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  const group = workflow.concurrency.group.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const sha = 'a'.repeat(40)
  const resolveGroup = (event_name: string, ref: string, expected_main_sha?: string) =>
    runInNewContext(group, {
      github: { workflow: 'bayn-build-push', ref, event_name, sha, run_id: 42 },
      inputs: { expected_main_sha },
      format: (template: string, ...values: unknown[]) =>
        template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)])),
    })
  expect(resolveGroup('push', 'refs/heads/main')).toBe('bayn-build-push-main')
  expect(resolveGroup('workflow_dispatch', 'refs/heads/main', sha)).toBe('bayn-build-push-main')
  expect(resolveGroup('workflow_dispatch', 'refs/heads/main', 'wrong')).not.toBe('bayn-build-push-main')
  expect(resolveGroup('workflow_dispatch', 'refs/heads/feature', sha)).not.toBe('bayn-build-push-main')
})

const runHistory = (id: number, sha: string, conclusion = 'success') => ({
  id,
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  conclusion,
  run_attempt: 2,
})

const withRepository = (testCase: (fixture: ReturnType<typeof fixtureAt>) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-publication-plan-'))
  try {
    testCase(fixtureAt(directory))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const fixtureAt = (directory: string) => {
  const checkout = join(directory, 'checkout')
  mkdirSync(checkout)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--initial-branch=main')
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const commit = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) write(join(checkout, path), content)
    git('add', '.')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'Bayn publication fixture',
    )
    return git('rev-parse', 'HEAD')
  }
  const initial = commit({
    [workflowFile]: workflowText,
    'services/bayn/src/runtime.ts': 'old runtime',
    'bun.lock': lockfile('1.0.0'),
  })
  const responses = join(directory, 'responses')
  writeFileSync(
    join(directory, 'gh'),
    '#!/bin/bash\nset -eu\n[[ "$#" == 4 && "$1" == api && "$3" == --jq ]]\njq -c "$4" "$RESPONSES/$2"\n',
    {
      mode: 0o755,
    },
  )
  const writeResponse = (endpoint: string, value: unknown) =>
    write(join(responses, api, endpoint), JSON.stringify(value))
  const history = (runs: ReturnType<typeof runHistory>[]) =>
    writeResponse('workflows/bayn-build-push.yml/runs?branch=main&status=success&per_page=100&page=1', {
      workflow_runs: runs,
    })
  const publisher = (id: number, sha: string, conclusion: string) =>
    writeResponse(`runs/${id}/attempts/2/jobs?per_page=100`, {
      jobs: [{ name: 'publish-cohort', status: 'completed', conclusion, head_sha: sha }],
    })
  const plan = (event = 'push') => {
    const step = workflow.jobs.changes.steps.find((item: { id?: string }) => item.id === 'plan')
    expect(workflow.jobs.changes.outputs.image).toBe('${{ steps.plan.outputs.image }}')
    expect(step.run).toBe('bun run packages/scripts/src/bayn/plan-publication.ts')
    const output = join(directory, 'output')
    writeFileSync(output, '')
    const result = Bun.spawnSync([process.execPath, 'run', join(root, step.run.split(' ').at(-1))], {
      cwd: checkout,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        RESPONSES: responses,
        GITHUB_REPOSITORY: 'proompteng/lab',
        GITHUB_EVENT_NAME: event,
        GITHUB_SHA: git('rev-parse', 'HEAD'),
        GITHUB_OUTPUT: output,
      },
    })
    return { status: result.exitCode, output: readFileSync(output, 'utf8'), stderr: result.stderr.toString() }
  }
  return { initial, commit, history, publisher, plan, git }
}

test('a lockfile-only successor builds unreleased runtime changes even after a successful no-op run', () => {
  withRepository(({ initial, commit, history, publisher, plan, git }) => {
    const release = commit({ 'services/bayn/src/runtime.ts': 'new runtime' })
    const skipped = commit({ 'bun.lock': lockfile('2.0.0') })
    const latest = commit({ 'bun.lock': lockfile('3.0.0') })
    expect(git('diff', '--name-only', skipped, latest)).toBe('bun.lock')
    history([runHistory(3, skipped), runHistory(2, release, 'cancelled'), runHistory(1, initial)])
    publisher(3, skipped, 'skipped')
    publisher(1, initial, 'success')
    expect(plan()).toMatchObject({ status: 0, output: 'image=true\n' })

    history([runHistory(4, latest), runHistory(3, skipped), runHistory(1, initial)])
    publisher(4, latest, 'success')
    commit({ 'bun.lock': lockfile('4.0.0') })
    expect(plan()).toMatchObject({ status: 0, output: 'image=false\n' })
    git('checkout', '--detach', release)
    expect(plan()).toMatchObject({ status: 0, output: 'image=false\n' })
  })
})

test('a lockfile-only push publishes if a Bayn dependency resolution changed', () => {
  withRepository(({ initial, commit, history, publisher, plan }) => {
    commit({ 'bun.lock': lockfile('1.0.0', 'changed-bayn-client-integrity') })
    history([runHistory(1, initial)])
    publisher(1, initial, 'success')
    expect(plan()).toMatchObject({ status: 0, output: 'image=true\n' })
  })
})

test('offline research and docs do not publish when there are no unreleased image inputs', () => {
  withRepository(({ initial, commit, history, publisher, plan }) => {
    commit({
      'services/bayn/tools/research-10yr-pure-etf-dual-horizon.ts': 'offline study',
      'services/bayn/tools/macro-canary-runner/README.md': 'operating guide',
    })
    commit({ 'apps/froussard/package.json': '{"name":"froussard"}' })
    history([runHistory(1, initial)])
    publisher(1, initial, 'success')
    expect(plan()).toMatchObject({ status: 0, output: 'image=false\n' })
  })
})

test('missing history builds conservatively, but a failed history request is not an empty history', () => {
  withRepository(({ history, plan }) => {
    expect(plan()).toMatchObject({ status: 1, output: '' })
    expect(plan('workflow_dispatch')).toMatchObject({ status: 0, output: 'image=true\n' })
    history([])
    expect(plan()).toMatchObject({ status: 0, output: 'image=true\n' })
  })
})
