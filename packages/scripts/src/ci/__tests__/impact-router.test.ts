import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { loadImpactMap, matchesGlob, selectImpactPlan } from '../impact-router'

const map = loadImpactMap('.github/ci/impact-map.yml')
const rootScriptMap = loadImpactMap('.github/ci/root-script-map.yml')

const yaml = (filename: string) =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8')) as {
    on: Record<string, unknown>
    concurrency: { group: string }
    jobs: Record<
      string,
      {
        if?: string
        uses?: string
        needs?: string[]
        secrets?: string
        steps?: { if?: string; run?: string; env?: Record<string, string> }[]
      }
    >
  }

test('queued revisions require scripts and protobuf validation without sharing a concurrency group', () => {
  const router = yaml('pull-request.yml')
  const gate = router.jobs['ci-pr']
  const step = gate.steps?.find(({ env }) => env?.BUF_RESULT !== undefined)
  const command = step?.run
  if (command === undefined) throw new Error('Queue gate step is missing')
  for (const [job, file, group] of [
    ['buf', 'buf-ci.yml', 'buf-'],
    ['scripts', 'scripts-ci.yml', 'packages-scripts-'],
  ]) {
    const workflow = yaml(file)
    expect(workflow.on).toHaveProperty('workflow_call')
    expect(workflow.on).not.toHaveProperty('merge_group')
    expect(workflow.concurrency.group).toStartWith(group)
    expect(router.jobs[job]).toMatchObject({
      if: "github.event_name == 'merge_group'",
      uses: `./.github/workflows/${file}`,
    })
    expect(router.jobs[job].needs).toBeUndefined()
    expect(gate.needs).toContain(job)
  }

  const run = (full: string, buf: string, scripts: string) =>
    Bun.spawnSync(['bash', '-c', command], {
      env: {
        PATH: process.env.PATH ?? '',
        PLAN_RESULT: 'success',
        VALIDATE_RESULT: 'success',
        VALIDATE_EXPECTED: 'success',
        LANDING_RESULT: 'success',
        LANDING_EXPECTED: 'success',
        AGENTS_RESULT: 'success',
        BAYN_RESULT: 'success',
        OFZ_RESULT: 'success',
        RELAY_RESULT: 'success',
        TENGRI_RESULT: 'success',
        BUF_RESULT: buf,
        SCRIPTS_RESULT: scripts,
        TORGHUT_RESULT: 'success',
        TORGHUT_SCHEMA_RESULT: 'success',
        TORGHUT_NOTEBOOKS_RESULT: 'success',
        QUEUE_SERVICES_RESULT: 'success',
        FULL_VALIDATION: full,
        DELEGATED: '[]',
      },
    }).exitCode
  expect(run('false', 'skipped', 'skipped')).toBe(0)
  expect(run('true', 'success', 'success')).toBe(0)
  for (const result of ['failure', 'cancelled', 'skipped']) {
    expect(run('true', result, 'success')).toBe(1)
    expect(run('true', 'success', result)).toBe(1)
  }
})

test('queued service validation joins the required gate without duplicate or mutually cancelling runs', () => {
  const router = yaml('pull-request.yml')
  const caller = router.jobs['queue-services']
  expect(caller).toMatchObject({
    if: "github.event_name == 'merge_group'",
    uses: './.github/workflows/queue-service-validation.yml',
  })
  expect(caller.secrets).toBeUndefined()
  const gate = router.jobs['ci-pr']
  expect(gate.needs).toContain('queue-services')

  const services = Object.values(yaml('queue-service-validation.yml').jobs)
  expect(services.map(({ uses }) => uses)).toContain('./.github/workflows/agentctl-ci.yml')
  const concurrencyGroups = new Set<string>()
  for (const service of services) {
    expect(service.if).toBeUndefined()
    expect(service.needs).toBeUndefined()
    expect(service.secrets).toBeUndefined()
    const filename = service.uses?.split('/').at(-1)
    if (!filename) throw new Error('Missing service workflow')
    const workflow = yaml(filename)
    expect(workflow.on).toHaveProperty('workflow_call')
    expect(workflow.on).not.toHaveProperty('merge_group')
    const prefix = workflow.concurrency.group.split('${{')[0].toLowerCase()
    expect(prefix).not.toBe('')
    expect(concurrencyGroups.has(prefix)).toBe(false)
    concurrencyGroups.add(prefix)
  }

  const step = gate.steps?.find(({ env }) => env?.QUEUE_SERVICES_RESULT !== undefined)
  if (!step?.run) throw new Error('Queue service result enforcement is missing')
  expect(step.env?.QUEUE_SERVICES_RESULT).toBe('${{ needs.queue-services.result }}')
  const command = step.run
  const run = (full: string, result: string) =>
    Bun.spawnSync(['bash', '-c', command], {
      env: {
        ...Object.fromEntries(Object.keys(step.env ?? {}).map((key) => [key, 'success'])),
        PATH: process.env.PATH ?? '',
        DELEGATED: '[]',
        FULL_VALIDATION: full,
        QUEUE_SERVICES_RESULT: result,
      },
    })
  expect(run('false', 'skipped').exitCode).toBe(0)
  expect(run('true', 'success').exitCode).toBe(0)
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const rejected = run('true', result)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr.toString()).toContain('Queue service validation failed')
  }
})

test('the PR gate requires all Jangar jobs when the runtime inputs are affected', () => {
  const router = yaml('pull-request.yml')
  expect(router.jobs.jangar).toMatchObject({
    needs: 'plan',
    if: "github.event_name == 'pull_request' && needs.plan.result == 'success' && needs.plan.outputs.jangar_affected == 'true'",
    uses: './.github/workflows/jangar-ci.yml',
  })
  const jangar = yaml('jangar-ci.yml')
  expect(Object.keys(jangar.on)).toEqual(['workflow_call'])
  expect(Object.keys(jangar.jobs).sort()).toEqual([
    'atlas-search-integration',
    'dependency-closure',
    'lint-and-typecheck',
  ])
  const gate = router.jobs['ci-pr']
  expect(gate.needs).toContain('jangar')
  const step = gate.steps?.find(({ env }) => env?.JANGAR_RESULT !== undefined)
  if (!step?.run) throw new Error('Jangar result enforcement is missing')
  expect(step.if).toBe("github.event_name == 'pull_request'")
  expect(step.env?.JANGAR_AFFECTED).toBe('${{ needs.plan.outputs.jangar_affected }}')
  expect(step.env?.JANGAR_RESULT).toBe('${{ needs.jangar.result }}')
  const command = step.run
  const run = (affected: string, result: string) =>
    Bun.spawnSync(['bash', '-c', command], {
      env: {
        PATH: process.env.PATH ?? '',
        JANGAR_AFFECTED: affected,
        JANGAR_RESULT: result,
      },
    })
  expect(run('true', 'success').exitCode).toBe(0)
  expect(run('false', 'skipped').exitCode).toBe(0)
  const missingDecision = run('', 'skipped')
  expect(missingDecision.exitCode).toBe(1)
  expect(missingDecision.stderr.toString()).toContain('Missing Jangar impact decision')
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const rejected = run('true', result)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr.toString()).toContain('Jangar validation failed:')
  }
})

describe('root script ownership', () => {
  test.each([
    ['argocd/applications/tengri/network-policies.yaml', ['kube-router']],
    ['scripts/seal-tengri-runtime.ts', ['tengri-secrets']],
    ['scripts/hermes/validate-production.ts', ['hermes']],
    ['argocd/applications/hermes/statefulset.yaml', ['hermes']],
    ['argocd/applications/hermes/network-policy.yaml', ['hermes', 'kube-router']],
    ['scripts/cluster-upgrades/ceph_upgrade_gate.py', ['cluster-upgrades']],
    ['argocd/applications/keycloak/postgres-upgrade-backup.yaml', ['cluster-upgrades']],
    ['argocd/applications/forgejo/upstream-image.json', ['forgejo']],
    ['scripts/jangar/validate-flamingo-hard-migration.ts', ['flamingo']],
    ['argocd/applications/flamingo/deployment.yaml', ['flamingo']],
    ['.github/workflows/pull-request.yml', ['all']],
    ['.github/ci/root-script-map.yml', ['all']],
    ['packages/scripts/src/ci/impact-router.ts', ['all']],
    ['scripts/validate-manifests.sh', ['planner']],
  ])('selects only the suites owning %s', (path, expected) => {
    expect(selectImpactPlan([path], rootScriptMap).validationTargets).toEqual(expected)
    expect(selectImpactPlan([path], map).validationTargets).toContain('root-scripts')
  })

  test('combines owned suites once in deterministic order', () => {
    expect(
      selectImpactPlan(
        ['scripts/seal-tengri-runtime.ts', 'scripts/forgejo/publish_image_test.py', 'scripts/forgejo/publish-image.sh'],
        rootScriptMap,
      ).validationTargets,
    ).toEqual(['forgejo', 'tengri-secrets'])
  })

  test.each(['services/ofz/src/control.rs', 'proto/proompteng/authz/v1/authz.proto'])(
    'keeps Landing consumer validation for %s',
    (path) => expect(selectImpactPlan([path], map).validationTargets).toContain('landing'),
  )
})

describe('impact router', () => {
  test('matches recursive and root-only globs', () => {
    expect(matchesGlob('argocd/applications/jangar/deployment.yaml', 'argocd/**/*.yaml')).toBe(true)
    expect(matchesGlob('argocd/applications/jangar/deployment.yml', 'argocd/**/*.yaml')).toBe(false)
    expect(matchesGlob('services/jangar/src/index.ts', 'services/jangar/**')).toBe(true)
    expect(matchesGlob('services/jangar', 'services/jangar/**')).toBe(true)
    expect(matchesGlob('services/jangar-old/src/index.ts', 'services/jangar/**')).toBe(false)
    expect(matchesGlob('scripts/check.sh', '**/*.sh')).toBe(true)
  })

  test('routes a docs-only change to docs validation', () => {
    const plan = selectImpactPlan(['apps/docs/content/index.mdx'], map)
    expect(plan.validationTargets).toEqual(['docs'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('plans every registered validation for a queued revision without a diff', () => {
    const targets = Object.entries(map.targets)
    expect(selectImpactPlan([], map, true)).toEqual({
      files: [],
      validationTargets: targets
        .filter(([, target]) => target.kind === 'validation')
        .map(([name]) => name)
        .sort(),
      delegatedWorkflows: [
        ...new Set(
          targets.flatMap(([, target]) => (target.kind === 'delegated' && target.workflow ? [target.workflow] : [])),
        ),
      ].sort(),
    })
    expect(selectImpactPlan([], rootScriptMap, true).validationTargets).toContain('all')
  })

  test('rejects a full plan with only the planner fallback', () => {
    expect(() =>
      selectImpactPlan([], { version: 1, targets: { planner: { kind: 'planner', paths: [] } } }, true),
    ).toThrow('Full CI plan has no validation targets')
  })

  test('Jangar source still validates the architecture inventory', () => {
    const plan = selectImpactPlan(['services/jangar/src/server.ts'], map)
    expect(plan.validationTargets).toEqual(['jangar-inventory'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('routes Olden changes to app validation', () => {
    const plan = selectImpactPlan(['apps/olden/src/app.tsx'], map)
    expect(plan.validationTargets).toEqual(['olden'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('routes design package changes through consumer compatibility validation', () => {
    const plan = selectImpactPlan(['packages/design/src/components/ui/button.tsx'], map)
    expect(plan.validationTargets).toEqual(['design', 'landing'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('routes a Torghut change to Torghut CI only', () => {
    const plan = selectImpactPlan(['services/torghut/src/main.py'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['torghut-ci'])
  })

  test('routes the shared Codex package to its dedicated validation', () => {
    const plan = selectImpactPlan(['packages/codex/src/app-server.ts'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['agents-ci', 'codex-ci'])
  })

  test('does not fan Codex tests into Agents runtime validation', () => {
    const plan = selectImpactPlan(['packages/codex/src/app-server.test.ts'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['codex-ci'])
  })

  test('routes Agents tests to the reusable unit tier', () => {
    const plan = selectImpactPlan(['services/agents/src/server/health.test.ts'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['agents-ci'])
  })

  test('routes only inventory-owning Agents sources through Jangar inventory validation', () => {
    const sourcePlan = selectImpactPlan(['services/agents/src/server/control-plane-cache.ts'], map)
    expect(sourcePlan.validationTargets).toEqual(['jangar-inventory'])
    expect(sourcePlan.delegatedWorkflows).toEqual(['agents-ci'])

    const uiPlan = selectImpactPlan(['services/agents/src/app-routes/primitives.tsx'], map)
    expect(uiPlan.validationTargets).toEqual(['jangar-inventory'])
    expect(uiPlan.delegatedWorkflows).toEqual(['agents-ci'])

    const testPlan = selectImpactPlan(['services/agents/src/server/control-plane-cache.test.ts'], map)
    expect(testPlan.validationTargets).toEqual(['planner'])
    expect(testPlan.delegatedWorkflows).toEqual(['agents-ci'])

    expect(selectImpactPlan(['docs/jangar/architecture-inventory.md'], map).validationTargets).toEqual([
      'jangar-inventory',
    ])
  })

  test('routes Agents chart changes to published-image smoke', () => {
    const plan = selectImpactPlan(['charts/agents/templates/deployment.yaml'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['agents-ci'])
  })

  test('keeps Agents documentation off the ARC workflow', () => {
    const plan = selectImpactPlan(['docs/agents/agentrun-creation-guide.md', 'services/agents/README.md'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('runs workflow lint and the reusable Agents contract for Agents workflow changes', () => {
    const plan = selectImpactPlan(['.github/workflows/agents-ci.yml'], map)
    expect(plan.validationTargets).toEqual(['workflow-lint'])
    expect(plan.delegatedWorkflows).toEqual(['agents-ci'])
  })

  test('routes runtime package dependencies through their owning delegated workflows', () => {
    expect(selectImpactPlan(['packages/otel/src/api.ts'], map).delegatedWorkflows).toEqual(['agents-ci', 'otel'])
    expect(selectImpactPlan(['packages/temporal-bun-sdk/src/index.ts'], map).delegatedWorkflows).toEqual([
      'agents-ci',
      'temporal-bun-sdk',
    ])
  })

  test('does not fan agentctl changes into the broader agents workflow', () => {
    const plan = selectImpactPlan(['services/agents/agentctl/src/cli.ts'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['agentctl-ci'])
  })

  test('routes shared lockfiles once', () => {
    const plan = selectImpactPlan(['bun.lock'], map)
    expect(plan.validationTargets).toEqual(['shared-compat'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('routes Nix lock changes through compatibility, manifest, and Agents image validation', () => {
    const plan = selectImpactPlan(['flake.lock'], map)
    expect(plan.validationTargets).toEqual(['kubeconform', 'shared-compat'])
    expect(plan.delegatedWorkflows).toEqual(['agents-ci'])
  })

  test('routes per-service Nix image changes to compatibility and manifest validation', () => {
    const plan = selectImpactPlan(['nix/images/jangar.nix'], map)
    expect(plan.validationTargets).toEqual(['kubeconform', 'shared-compat'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('routes Agents-owned Nix image changes through compatibility and Agents smoke validation', () => {
    for (const path of [
      'flake.nix',
      'nix/images/agents.nix',
      'nix/images/bun-workspace-service.nix',
      'nix/images/openai-codex-cli.nix',
      'nix/packages.nix',
    ]) {
      const plan = selectImpactPlan([path], map)
      expect(plan.validationTargets).toEqual(['kubeconform', 'shared-compat'])
      expect(plan.delegatedWorkflows).toEqual(['agents-ci'])
    }
  })

  test('routes the shared Nix OCI deploy helper through Agents local-image validation', () => {
    const plan = selectImpactPlan(['packages/scripts/src/shared/nix-oci-deploy.ts'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['agents-ci', 'scripts-ci'])
  })

  test('routes a package and infrastructure change without duplicate targets', () => {
    const plan = selectImpactPlan(['packages/k8s/src/cli.ts', 'argocd/applications/docs/generated/app.yaml'], map)
    expect(plan.validationTargets).toEqual(['argo-lint', 'cdk8s', 'kubeconform'])
  })

  test('routes Kubernetes YAML to schema validation', () => {
    const plan = selectImpactPlan(['kubernetes/base/deployment.yaml'], map)
    expect(plan.validationTargets).toEqual(['kubeconform'])
  })

  test('validates standalone kubeconform workflow changes through the PR router', () => {
    expect(Object.keys(yaml('kubeconform.yml').on)).toEqual(['push'])
    const plan = selectImpactPlan(['.github/workflows/kubeconform.yml'], map)
    expect(plan.validationTargets).toContain('kubeconform')
  })

  test('routes the Bayn rendered secret-mode regression through schema validation', () => {
    expect(selectImpactPlan(['scripts/test-bayn-secret-file-mode.sh'], map).validationTargets).toContain('kubeconform')
  })

  test.each([
    'services/ofz/test-ha-manifests.sh',
    'services/ofz/tests/ha_manifests.py',
    '.github/workflows/pull-request.yml',
  ])('routes the HA render checker through schema validation: %s', (file) => {
    expect(selectImpactPlan([file], map).validationTargets).toContain('kubeconform')
  })

  test('routes Argo CD application changes through scripts contract tests', () => {
    const plan = selectImpactPlan(['argocd/applications/argocd/overlays/argocd-cm.yaml'], map)
    expect(plan.validationTargets).toEqual(['argo-lint', 'kubeconform'])
    expect(plan.delegatedWorkflows).toEqual(['scripts-ci'])
  })

  test('routes Flink observability and S3A documentation through scripts contract tests', () => {
    const plan = selectImpactPlan(
      ['argocd/applications/observability/cluster-metrics-alloy-config.river', 'docs/torghut/ceph-migration.md'],
      map,
    )
    expect(plan.validationTargets).toEqual(['argo-lint', 'kubeconform', 'root-scripts'])
    expect(plan.delegatedWorkflows).toEqual(['scripts-ci'])
  })

  test('keeps mixed service changes deterministic', () => {
    const plan = selectImpactPlan(['services/jangar/src/server.ts', 'services/torghut/src/main.py'], map)
    expect(plan.validationTargets).toEqual(['jangar-inventory'])
    expect(plan.delegatedWorkflows).toEqual(['torghut-ci'])
  })

  test('routes workflow-only changes to actionlint', () => {
    const plan = selectImpactPlan(['.github/workflows/example.yml'], map)
    expect(plan.validationTargets).toEqual(['workflow-lint'])
  })

  test('keeps root script validation separate from packages/scripts CI', () => {
    const plan = selectImpactPlan(['scripts/validate-manifests.sh'], map)
    expect(plan.validationTargets).toEqual(['root-scripts', 'shellcheck'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('routes every Hermes production surface through root script validation', () => {
    const cases = [
      ['argocd/applications/hermes/statefulset.yaml', ['argo-lint', 'kubeconform', 'root-scripts']],
      ['argocd/applications/kargo/stages.yaml', ['argo-lint', 'kubeconform', 'root-scripts']],
      ['argocd/applications/observability/graf-mimir-rules.yaml', ['argo-lint', 'kubeconform', 'root-scripts']],
      [
        'argocd/applications/observability/cluster-metrics-alloy-config.river',
        ['argo-lint', 'kubeconform', 'root-scripts'],
      ],
      [
        'argocd/applications/observability/cluster-metrics-alloy-deployment.yaml',
        ['argo-lint', 'kubeconform', 'root-scripts'],
      ],
      [
        'argocd/applications/observability/kube-state-metrics-values.yaml',
        ['argo-lint', 'kubeconform', 'root-scripts'],
      ],
      ['argocd/applicationsets/platform.yaml', ['argo-lint', 'kubeconform', 'root-scripts']],
      ['docs/runbooks/hermes-production-rollout.md', ['root-scripts']],
      ['.github/ci/impact-map.yml', ['root-scripts', 'workflow-lint']],
      ['.github/workflows/pull-request.yml', ['kubeconform', 'root-scripts', 'workflow-lint']],
      ['.github/workflows/hermes-agent-mirror.yml', ['root-scripts', 'workflow-lint']],
    ] as const

    for (const [file, expectedTargets] of cases) {
      expect(selectImpactPlan([file], map).validationTargets).toEqual(expectedTargets)
    }
  })

  test('always returns a planner target for an unmapped file', () => {
    const plan = selectImpactPlan(['README.md'], map)
    expect(plan.validationTargets).toEqual(['planner'])
  })
})
