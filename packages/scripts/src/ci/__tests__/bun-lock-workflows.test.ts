import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { matchesPaths, parseTargets, selectAffectedInputs } from '../affected-inputs'

type PlannerInputs = {
  workspaces: string
  filters?: string
  workflow?: string
  'dependency-aware-push'?: string
}

type Workflow = {
  on: { push?: { paths: string[] } }
  concurrency?: { group: string }
  jobs: Record<
    string,
    {
      if?: string
      needs?: string | string[]
      outputs?: Record<string, string>
      steps?: { id?: string; uses?: string; with?: PlannerInputs }[]
    }
  >
}

const workflows = new Map<string, Workflow>()
const readWorkflow = (filename: string) => {
  const cached = workflows.get(filename)
  if (cached) return cached
  const workflow = Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8')) as Workflow
  workflows.set(filename, workflow)
  return workflow
}

const pushWorkflows = readdirSync('.github/workflows').filter(
  (filename) =>
    /\.ya?ml$/.test(filename) &&
    filename !== 'bayn-build-push.yml' && // Bayn already compares with the last verified publication.
    readWorkflow(filename).on.push?.paths?.includes('bun.lock'),
)

const planner = ({ jobs }: ReturnType<typeof readWorkflow>) => {
  for (const [id, job] of Object.entries(jobs)) {
    const step = job.steps?.find(({ uses }) => uses === './.github/actions/affected-inputs')
    if (step?.with && step.id) return { id, stepId: step.id, inputs: step.with }
  }
  throw new Error('Missing affected-inputs planner')
}

const configuredTargets = (inputs: PlannerInputs, event: string) =>
  parseTargets(inputs.workspaces, inputs.filters ?? '', inputs.workflow ?? '', event)

const pushTargets = new Map(
  pushWorkflows.map((filename) => [filename, configuredTargets(planner(readWorkflow(filename)).inputs, 'push')]),
)
const targetsForPush = (filename: string) => {
  const targets = pushTargets.get(filename)
  if (!targets) throw new Error(`Missing push targets for ${filename}`)
  return targets
}

const lock = Bun.JSONC.parse(readFileSync('bun.lock', 'utf8')) as {
  workspaces: Record<string, { devDependencies?: Record<string, string> }>
  packages: Record<string, unknown>
}

const withWorkspaceDependency = (path: string) => ({
  ...lock,
  workspaces: {
    ...lock.workspaces,
    [path]: { ...lock.workspaces[path], devDependencies: { ...lock.workspaces[path].devDependencies, fixture: '1.0' } },
  },
  packages: { ...lock.packages, fixture: ['fixture@1.0.0', '', {}, 'fixture-integrity'] },
})
const scriptsLockChange = withWorkspaceDependency('packages/scripts')

const evaluate = (condition: string, context: object) =>
  runInNewContext(condition.replace(/^\s*\$\{\{|\}\}\s*$/g, ''), context)

test.each(pushWorkflows)('%s skips main work for a packages/scripts-only lockfile edit', (filename) => {
  const workflow = readWorkflow(filename)
  const { id, stepId, inputs } = planner(workflow)
  expect(inputs['dependency-aware-push']).toBe('true')
  const targets = targetsForPush(filename)
  const affected = selectAffectedInputs(['bun.lock'], targets, lock, scriptsLockChange)
  expect(Object.values(affected)).not.toContain(true)

  const gatedJobs = Object.values(workflow.jobs).filter(({ needs }) => [needs].flat().includes(id))
  expect(gatedJobs.length).toBeGreaterThan(0)
  const github = { event_name: 'push', ref: 'refs/heads/main', event: { pull_request: {} } }
  const runnable = (plan: Record<string, boolean>) => {
    const steps = {
      [stepId]: { outputs: { affected: JSON.stringify(plan) } },
      cutover: { outputs: { cutover_ready: 'true' } },
    }
    const outputs = Object.fromEntries(
      Object.entries(workflow.jobs[id].outputs ?? {}).map(([name, expr]) => [
        name,
        String(evaluate(expr, { github, steps, fromJSON: JSON.parse })),
      ]),
    )
    return gatedJobs.map((job) => {
      if (!job.if) throw new Error('Job depends on input planning but does not check its decision')
      return evaluate(
        job.if.replaceAll('needs.verify-app-dependency-closure', 'needs["verify-app-dependency-closure"]'),
        {
          github,
          cancelled: () => false,
          contains: (value: string, part: string) => value.includes(part),
          needs: { [id]: { result: 'success', outputs }, 'verify-app-dependency-closure': { result: 'success' } },
        },
      )
    })
  }
  expect(runnable(affected)).not.toContain(true)
  expect(runnable(Object.fromEntries(Object.keys(affected).map((name) => [name, true])))).toContain(true)

  const group = workflow.concurrency?.group
  if (group) {
    const pushGroup = (run_id: number) =>
      group.replaceAll(/\$\{\{(.*?)\}\}/g, (_, expression) =>
        String(evaluate(expression, { github: { ...github, workflow: filename, run_id } })),
      )
    expect(pushGroup(1)).not.toBe(pushGroup(2))
  }
})

const desktopCohort = {
  'ofz.yaml': 'ofz',
  'tengri-images.yml': 'desktop',
  'product-nix-images.yml': 'proompteng',
}

test('Ofz keeps centrally selected PR and merge-queue checks and main-only manual publication', () => {
  const { changes, validate, 'build-ofz': publish } = readWorkflow('ofz.yaml').jobs
  if (!changes.if || !validate.if || !publish.if) throw new Error('Missing Ofz event guard')
  for (const event_name of ['pull_request', 'merge_group', 'workflow_dispatch']) {
    const github = { event_name, ref: 'refs/heads/main' }
    const context = {
      github,
      needs: { changes: { result: 'skipped' }, validate: { result: 'success' } },
      cancelled: () => false,
    }
    expect(evaluate(changes.if, context)).toBe(false)
    expect(evaluate(validate.if, context)).toBe(true)
    expect(evaluate(publish.if, context)).toBe(event_name === 'workflow_dispatch')
    expect(evaluate(publish.if, { ...context, github: { ...github, ref: 'refs/heads/topic' } })).toBe(false)
  }
})
const torghutCohort = Object.fromEntries(
  [
    'torghut-build-push.yaml',
    'torghut-notebook-build-push.yaml',
    'torghut-ta-build-push.yaml',
    'torghut-ws-build-push.yaml',
    'signal-publisher-build-push.yml',
  ].map((filename) => [filename, 'service']),
)

test.each([desktopCohort, torghutCohort])('co-built images use identical push input boundaries', (cohort) => {
  const selected = Object.entries(cohort).map(([filename, target]) => targetsForPush(filename)[target])
  expect(selected[0]).toBeDefined()
  for (const config of selected.slice(1)) expect(config).toEqual(selected[0])
})

test.each([
  ['services/tengri/src/slot/vmm.rs', desktopCohort],
  ['services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/BrokerFeedMain.kt', torghutCohort],
] as [string, Record<string, string>][])(
  'a push with %s still selects the cohort alongside an unrelated lockfile edit',
  (source, cohort) => {
    for (const [filename, target] of Object.entries(cohort)) {
      const workflow = readWorkflow(filename)
      const targets = targetsForPush(filename)
      expect(matchesPaths(source, workflow.on.push?.paths ?? []), filename).toBe(true)
      expect(selectAffectedInputs(['bun.lock', source], targets, lock, scriptsLockChange)[target], filename).toBe(true)
    }
  },
)

test.each([
  ['services/bumba', { 'bumba-ci.yml': ['service'] }],
  ['packages/discord', { 'oirat-ci.yml': ['service'] }],
  ['apps/froussard', { 'froussard-ci.yml': ['service'] }],
  ['packages/k8s', { 'cdk8s-manifests.yml': ['k8s'] }],
  ['services/bayn', { 'opencode-build-push.yml': ['image'] }],
  ['apps/app', { 'product-nix-images.yml': ['app', 'app_dependencies'] }],
  ['apps/docs', { 'product-nix-images.yml': ['docs'] }],
  ['apps/synthesis', { 'product-nix-images.yml': ['synthesis'] }],
  [
    'apps/landing',
    {
      ...Object.fromEntries(Object.entries(desktopCohort).map(([file, target]) => [file, [target]])),
      'tengri.yaml': ['desktop'],
    },
  ],
  ['services/signal-publisher', Object.fromEntries(Object.keys(torghutCohort).map((file) => [file, ['service']]))],
] as [string, Record<string, string[]>][])('main selects the consumers of %s', (path, expected) => {
  const changed = withWorkspaceDependency(path)
  const lockfileSelections = new Map<string, string[]>()
  for (const filename of pushWorkflows) {
    const workflow = readWorkflow(filename)
    const targets = targetsForPush(filename)
    const selected = (files: string[], head: unknown) =>
      Object.entries(selectAffectedInputs(files, targets, lock, head))
        .filter(([, affected]) => affected)
        .map(([name]) => name)
    // Co-built workflows with identical parsed inputs need only one dependency-graph comparison.
    const inputKey = JSON.stringify(targets)
    let lockfileSelection = lockfileSelections.get(inputKey)
    if (!lockfileSelection) {
      lockfileSelection = selected(['bun.lock'], changed)
      lockfileSelections.set(inputKey, lockfileSelection)
    }
    expect(lockfileSelection, filename).toEqual(expected[filename] ?? [])
    const manifest = `${path}/package.json`
    if (expected[filename]) {
      expect(matchesPaths(manifest, workflow.on.push?.paths ?? []), filename).toBe(true)
      expect(selected([manifest], lock), filename).toEqual(expected[filename])
    }
  }
})

test('Auto Ontology scopes PR validation to its installed script dependencies', () => {
  const targets = configuredTargets(planner(readWorkflow('auto-ontology-validate.yml')).inputs, 'pull_request')
  expect(selectAffectedInputs(['bun.lock'], targets, lock, withWorkspaceDependency('apps/landing'))).toEqual({
    ontology: false,
  })
  expect(selectAffectedInputs(['bun.lock'], targets, lock, scriptsLockChange)).toEqual({ ontology: true })
})
