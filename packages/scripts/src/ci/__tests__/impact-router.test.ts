import { describe, expect, test } from 'bun:test'
import { loadImpactMap, matchesGlob, selectImpactPlan } from '../impact-router'

const map = loadImpactMap('.github/ci/impact-map.yml')

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

  test('routes a service change to its owner without image validation', () => {
    const plan = selectImpactPlan(['services/jangar/src/server.ts'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['jangar-ci'])
  })

  test('routes Olden changes to app validation', () => {
    const plan = selectImpactPlan(['apps/olden/src/app.tsx'], map)
    expect(plan.validationTargets).toEqual(['olden'])
    expect(plan.delegatedWorkflows).toEqual([])
  })

  test('routes design package changes through consumer compatibility validation', () => {
    const plan = selectImpactPlan(['packages/design/src/components/ui/button.tsx'], map)
    expect(plan.validationTargets).toEqual(['design'])
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

  test('routes runtime package dependencies through package and Agents validation', () => {
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

  test('routes Nix lock changes through compatibility and Agents image validation', () => {
    const plan = selectImpactPlan(['flake.lock'], map)
    expect(plan.validationTargets).toEqual(['shared-compat'])
    expect(plan.delegatedWorkflows).toEqual(['agents-ci'])
  })

  test('routes per-service Nix image changes to compatibility validation', () => {
    const plan = selectImpactPlan(['nix/images/jangar.nix'], map)
    expect(plan.validationTargets).toEqual(['shared-compat'])
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
      expect(plan.validationTargets).toEqual(['shared-compat'])
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
    expect(plan.validationTargets).toEqual(['argo-lint', 'kubeconform'])
    expect(plan.delegatedWorkflows).toEqual(['scripts-ci'])
  })

  test('keeps mixed service changes deterministic', () => {
    const plan = selectImpactPlan(['services/jangar/src/server.ts', 'services/torghut/src/main.py'], map)
    expect(plan.validationTargets).toEqual(['planner'])
    expect(plan.delegatedWorkflows).toEqual(['jangar-ci', 'torghut-ci'])
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
      ['argocd/applications/observability/graf-mimir-rules.yaml', ['argo-lint', 'kubeconform', 'root-scripts']],
      ['argocd/applicationsets/platform.yaml', ['argo-lint', 'kubeconform', 'root-scripts']],
      ['docs/runbooks/hermes-production-rollout.md', ['root-scripts']],
      ['.github/ci/impact-map.yml', ['root-scripts', 'workflow-lint']],
      ['.github/workflows/pull-request.yml', ['root-scripts', 'workflow-lint']],
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
