import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { loadImpactMap, selectImpactPlan } from '../../ci/impact-router'
import { classifyAgentsImageMode } from '../resolve-agents-image-mode'

type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  uses?: string
  'continue-on-error'?: boolean
  steps?: {
    name: string
    uses?: string
    if?: string
    with?: Record<string, string>
    run?: string
    env?: Record<string, string>
  }[]
}

const loadWorkflow = (name: string): { jobs: Record<string, Job> } =>
  parse(readFileSync(new URL(`../../../../../.github/workflows/${name}`, import.meta.url), 'utf8'))

const impactMap = loadImpactMap('.github/ci/impact-map.yml')
const stepCommand = (workflow: string, step: string): string => {
  const command = loadWorkflow(workflow).jobs.plan?.steps?.find(({ name }) => name === step)?.run
  if (command === undefined) throw new Error(`Missing workflow command: ${workflow} / ${step}`)
  return command
}
const doc = 'docs/agents/collective-knowledge-workflow.md'
const offlineScripts = [
  'packages/scripts/src/agents/curate-ontology-deltas.ts',
  'packages/scripts/src/agents/sync-auto-ontology-bundle.ts',
  'packages/scripts/src/agents/__tests__/sync-auto-ontology-bundle.test.ts',
]

const pullRequestPlan = (paths: string[]) => {
  const { files, delegatedWorkflows } = selectImpactPlan(paths, impactMap)
  expect(delegatedWorkflows).toContain('agents-ci')
  return classifyAgentsImageMode(files, 'pull_request')
}

test.each([[doc], offlineScripts, [doc, ...offlineScripts]].map((paths) => [paths]))(
  'selects only fast checks for %j',
  (paths) => {
    expect(pullRequestPlan(paths)).toMatchObject({
      tier: 'fast',
      runUnit: false,
      runStatic: false,
      runIntegration: false,
      imageTargets: [],
    })
  },
)

test.each([
  ['services/agents/src/server/health.ts', 'local-smoke'],
  ['services/agents/src/server/health.test.ts', 'published-smoke'],
  ['services/agents/agentctl/src/cli.ts', 'published-smoke'],
  ['charts/agents/templates/deployment.yaml', 'published-smoke'],
  ['charts/agents/README.md', 'published-smoke'],
  ['argocd/applications/agents/values.yaml', 'published-smoke'],
  ['nix/images/agents.nix', 'local-smoke'],
  ['nix/images/jangar.nix', 'published-smoke'],
  ['.github/workflows/agents-ci.yml', 'published-smoke'],
  ['scripts/agents/values-ci.yaml', 'published-smoke'],
  ['packages/scripts/src/agents/smoke-agents.ts', 'published-smoke'],
  ['packages/scripts/src/agents/collect-smoke-diagnostics.ts', 'published-smoke'],
  ['packages/scripts/src/agents/resolve-published-agents-images.ts', 'published-smoke'],
  ['packages/scripts/src/agents/new-tool.ts', 'published-smoke'],
])('requires Kind for %s alone and with offline edits', (path, tier) => {
  for (const paths of [[path], [doc, ...offlineScripts, path]]) {
    expect(pullRequestPlan(paths)).toMatchObject({ tier, runIntegration: true })
  }
})

test('does not skip Kind for an Agents docs PR mixed with an unmapped path', () => {
  for (const path of ['README.md', ` ${offlineScripts[0]}`]) {
    expect(pullRequestPlan([doc, path])).toMatchObject({ tier: 'published-smoke', runIntegration: true })
  }
})

test('a Git rename from runtime to docs still routes both paths through Kind', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agents-ci-rename-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: temp, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.name', 'CI contract fixture')
    git('config', 'user.email', 'ci-fixture@example.test')
    git('config', 'commit.gpgsign', 'false')

    const runtimePath = 'services/agents/src/renamed.ts'
    const docsPath = 'docs/agents/renamed note\nwith a newline.md'
    for (const path of [runtimePath, docsPath]) mkdirSync(join(temp, dirname(path)), { recursive: true })
    writeFileSync(join(temp, runtimePath), 'old runtime content\n')
    git('add', runtimePath)
    git('commit', '-qm', 'Runtime base')
    const base = git('rev-parse', 'HEAD')
    git('mv', runtimePath, docsPath)
    git('commit', '-qm', 'Move to docs')
    const head = git('rev-parse', 'HEAD')
    const merge = git('commit-tree', 'HEAD^{tree}', '-p', base, '-p', head, '-m', 'Synthetic PR merge')
    git('update-ref', 'HEAD', merge)

    const env = { PATH: process.env.PATH ?? '', RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'github-output') }
    const derive = Bun.spawnSync(['bash', '-c', stepCommand('pull-request.yml', 'Derive changed files from Git')], {
      cwd: temp,
      env,
    })
    expect(derive.exitCode).toBe(0)
    const files = readFileSync(env.GITHUB_OUTPUT, 'utf8').match(/^changed_files=(.+)$/m)?.[1]
    if (!files) throw new Error('Changed file path was not emitted by the PR router')
    const route = Bun.spawnSync(['bash', '-c', stepCommand('pull-request.yml', 'Resolve impact targets')], {
      env: { ...env, CHANGED_FILES: files, FULL_VALIDATION: 'false' },
    })
    expect(route.exitCode).toBe(0)
    const plan = JSON.parse(route.stdout.toString())
    expect(plan.files).toEqual([docsPath, runtimePath])
    expect(plan.delegatedWorkflows).toContain('agents-ci')
    expect(classifyAgentsImageMode(plan.files, 'pull_request').runIntegration).toBe(true)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('the Agents planner emits a fast plan only from a valid nonempty PR payload', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agents-ci-plan-'))
  try {
    const env = { PATH: process.env.PATH ?? '', RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'github-output') }
    const resolve = stepCommand('agents-ci.yml', 'Resolve changed files')
    const classify = stepCommand('agents-ci.yml', 'Classify Agents validation')
    for (const [input, expected] of [
      [JSON.stringify([doc]), 'tier=fast'],
      [JSON.stringify([doc, 'charts/agents/Chart.yaml']), 'tier=published-smoke'],
      ['[]', null],
      ['["docs/agents/../other.md"]', null],
      ['["docs/agents/note.md", null]', null],
      ['{invalid', null],
      ['', null],
    ] as const) {
      writeFileSync(env.GITHUB_OUTPUT, '')
      const step = Bun.spawnSync(['bash', '-c', resolve], {
        env: { ...env, EVENT_NAME: 'pull_request', CHANGED_FILES_JSON: input },
      })
      if (!input) {
        expect(step.exitCode).toBe(1)
        expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('')
        continue
      }
      expect(step.exitCode).toBe(0)
      const path = readFileSync(env.GITHUB_OUTPUT, 'utf8').match(/^path=(.+)$/m)?.[1]
      if (!path) throw new Error('Changed file path was not emitted by the Agents workflow')
      const result = Bun.spawnSync(['bash', '-c', classify], {
        env: { ...env, GITHUB_EVENT_NAME: 'pull_request', CHANGED_FILES: path },
      })
      const outputs = readFileSync(env.GITHUB_OUTPUT, 'utf8')
      if (expected === null) {
        expect(result.exitCode).not.toBe(0)
        expect(outputs).not.toContain('tier=')
      } else {
        expect(result.exitCode).toBe(0)
        expect(outputs.split('\n')).toContain(expected)
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('fast checks reuse the planner without waiting for any service, chart, or smoke job', () => {
  const { jobs } = loadWorkflow('agents-ci.yml')
  expect(jobs.plan.needs).toBeUndefined()
  expect(jobs.plan).not.toHaveProperty('services')
  for (const name of ['Install fast-tier dependencies', 'Run Agents fast checks']) {
    expect(jobs.plan.steps?.find((step) => step.name === name)?.if).toBe("steps.classify.outputs.tier == 'fast'")
  }
  const checks = stepCommand('agents-ci.yml', 'Run Agents fast checks')
  for (const check of ['oxfmt --check', 'oxlint --config', 'typecheck:ontology', 'bun test']) {
    expect(checks).toContain(check)
  }
})

test('only a direct Agents push needs history to plan validation', () => {
  const { jobs } = loadWorkflow('agents-ci.yml')
  const checkout = jobs.plan?.steps?.find((step) => step.uses === 'actions/checkout@v5')
  expect(checkout?.with?.['fetch-depth']).toBe("${{ github.event_name == 'push' && '0' || '1' }}")
})

test('Agents unit, static, and Kind start from the same plan without dropping enforceable results', () => {
  const { jobs } = loadWorkflow('agents-ci.yml')
  for (const [id, name, selected] of [
    ['unit', 'Agents typecheck and unit tests', "${{ needs.plan.outputs.run_unit == 'true' }}"],
    ['static', 'Validate Agents chart and CRDs', "${{ needs.plan.outputs.run_static == 'true' }}"],
    [
      'integration',
      'Agents Kind smoke (${{ needs.plan.outputs.tier }})',
      "${{ needs.plan.outputs.run_integration != 'false' }}",
    ],
  ]) {
    expect(jobs[id]).toMatchObject({ name, needs: 'plan', if: selected })
    expect(jobs[id]?.['continue-on-error']).toBeUndefined()
  }

  const router = loadWorkflow('pull-request.yml')
  for (const caller of ['agents', 'agents-full']) {
    expect(router.jobs[caller]?.uses).toBe('./.github/workflows/agents-ci.yml')
    expect(router.jobs['ci-pr']?.needs).toContain(caller)
  }
  const gate = router.jobs['ci-pr']?.steps?.find((step) => step.name === 'Enforce selected validation results')
  expect(gate?.env?.AGENTS_RESULT).toBe(
    "${{ github.event_name == 'merge_group' && needs.agents-full.result || needs.agents.result }}",
  )
  if (!gate?.run) throw new Error('Missing ci-pr gate command')

  const successfulJobs = Object.fromEntries(
    Object.keys(gate.env ?? {})
      .filter((name) => name.endsWith('_RESULT'))
      .map((name) => [name, 'success']),
  )
  for (const [fullValidation, delegated, agentsResult, exitCode] of [
    ['false', '["agents-ci"]', 'success', 0],
    ['false', '["agents-ci"]', 'failure', 1],
    ['false', '["agents-ci"]', 'cancelled', 1],
    ['false', '["agents-ci"]', 'skipped', 1],
    ['false', '', 'skipped', 1],
    ['false', '[]', 'skipped', 0],
    ['true', '[]', 'success', 0],
    ['true', '[]', 'skipped', 1],
  ] as const) {
    const result = Bun.spawnSync(['bash', '-c', gate.run], {
      env: {
        ...successfulJobs,
        PATH: process.env.PATH ?? '',
        VALIDATE_EXPECTED: 'success',
        LANDING_EXPECTED: 'success',
        AGENTS_RESULT: agentsResult,
        FULL_VALIDATION: fullValidation,
        DELEGATED: delegated,
      },
    })
    expect(result.exitCode).toBe(exitCode)
  }
})
