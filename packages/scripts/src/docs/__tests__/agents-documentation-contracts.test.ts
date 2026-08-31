import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, parseAllDocuments } from 'yaml'

import { repoRoot } from '../../shared/cli'

type JsonObject = Record<string, unknown>

type OpenApiSchema = {
  additionalProperties?: boolean | OpenApiSchema
  enum?: unknown[]
  items?: OpenApiSchema
  properties?: Record<string, OpenApiSchema>
  required?: string[]
  type?: string
  'x-kubernetes-preserve-unknown-fields'?: boolean
}

type Crd = {
  spec: {
    group: string
    names: { kind: string }
    scope: string
    versions: Array<{
      name: string
      schema: { openAPIV3Schema: OpenApiSchema }
    }>
  }
}

type KubernetesResource = {
  apiVersion?: string
  kind?: string
  spec?: unknown
}

const primitiveDocs = [
  'docs/agents/primitives/agent.md',
  'docs/agents/primitives/memory.md',
  'docs/agents/primitives/orchestration.md',
] as const

const crdPaths = [
  'charts/agents/crds/agents.proompteng.ai_agents.yaml',
  'charts/agents/crds/agents.proompteng.ai_agentruns.yaml',
  'charts/agents/crds/agents.proompteng.ai_agentproviders.yaml',
  'charts/agents/crds/agents.proompteng.ai_memories.yaml',
  'charts/agents/crds/orchestration.proompteng.ai_orchestrations.yaml',
  'charts/agents/crds/orchestration.proompteng.ai_orchestrationruns.yaml',
] as const

const retiredDocs = [
  'docs/olden-era-wiki-deployment-design.md',
  'docs/nix-enabled-app-rollout-evidence-2026-07-05.md',
  'docs/runbooks/cluster-application-upgrades-2026-08.md',
  'docs/cdk8s-adoption-rollout-proof-2026-07-09.md',
  'docs/agents/agents-shell-effect-schema-modularization-plan.md',
  'docs/torghut/autoresearch-runner-ci-single-job-refactor-plan.md',
  'docs/torghut/main-simple-pipeline-refactor-production-plan.md',
  'docs/torghut/llm-review-via-jangar-plan.md',
  'docs/torghut/tech-debt/pylint-file-length-remediation-tracker-2026-06-12.md',
  'docs/torghut/tech-debt/pylint-refactor-quality-rollout-plan.md',
  'docs/runbooks/codex-docker.md',
  'docs/torghut/ops-2026-05-05-chip-universe-rollout.md',
  'docs/torghut/oracle/2026-05-22-torghut-profit-breakthrough-prompt.md',
  'docs/torghut/rollouts/2026-07-14-storage-write-pressure-remediation.md',
  'docs/agents/designs/leader-election-ha.md',
  'docs/agents/designs/61-jangar-runtime-kit-ledger-and-execution-class-admission-contract-2026-03-20.md',
  'docs/agents/designs/66-jangar-recovery-release-lanes-and-rollout-proof-fence-contract-2026-03-21.md',
  'docs/torghut/design-system/v6/60-torghut-hypothesis-passports-and-profit-guardrail-admission-contract-2026-03-20.md',
  'docs/torghut/design-system/v6/65-torghut-opportunity-books-and-source-freshness-warrant-contract-2026-03-21.md',
  'docs/torghut/design-system/implementation-audit.md',
  'docs/torghut/design-system/implementation-status-matrix-2026-02-21.md',
] as const

const readRepoFile = (path: string) => readFileSync(join(repoRoot, path), 'utf8')

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const listMarkdownFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listMarkdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })

const extractYamlResources = (path: string): KubernetesResource[] => {
  const resources: KubernetesResource[] = []
  const source = readRepoFile(path)

  for (const match of source.matchAll(/```ya?ml\s*\n([\s\S]*?)```/g)) {
    const documents = parseAllDocuments(match[1])
    for (const document of documents) {
      expect(document.errors, `${path} contains invalid YAML`).toHaveLength(0)
      const value = document.toJS() as unknown
      if (isObject(value)) resources.push(value as KubernetesResource)
    }
  }

  return resources
}

const validateValue = (value: unknown, schema: OpenApiSchema, path: string): void => {
  if (value === undefined || value === null) return

  if (schema.enum) expect(schema.enum, `${path} must use a declared enum value`).toContain(value)

  if (Array.isArray(value)) {
    expect(schema.type, `${path} must be an array in the CRD`).toBe('array')
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`))
    return
  }

  if (!isObject(value)) {
    if (schema.type === 'string') expect(typeof value, `${path} must be a string in the CRD`).toBe('string')
    if (schema.type === 'boolean') expect(typeof value, `${path} must be a boolean in the CRD`).toBe('boolean')
    if (schema.type === 'number') expect(typeof value, `${path} must be a number in the CRD`).toBe('number')
    if (schema.type === 'integer') {
      expect(typeof value, `${path} must be an integer in the CRD`).toBe('number')
      expect(Number.isInteger(value), `${path} must be an integer in the CRD`).toBe(true)
    }
    return
  }
  expect(schema.type, `${path} must be an object in the CRD`).toBe('object')

  for (const required of schema.required ?? []) {
    expect(Object.hasOwn(value, required), `${path}.${required} is required by the CRD`).toBe(true)
  }

  if (schema['x-kubernetes-preserve-unknown-fields']) return

  for (const [key, child] of Object.entries(value)) {
    let childSchema = schema.properties?.[key]
    if (!childSchema && isObject(schema.additionalProperties)) childSchema = schema.additionalProperties
    if (!childSchema && schema.additionalProperties !== true) {
      throw new Error(`${path}.${key} is not declared by the generated CRD`)
    }
    if (childSchema) validateValue(child, childSchema, `${path}.${key}`)
  }
}

describe('Agents documentation contracts', () => {
  it('keeps primitive YAML examples inside the generated CRD schemas', () => {
    const resources = primitiveDocs.flatMap(extractYamlResources)
    const crds = new Map(
      crdPaths.map((path) => {
        const crd = parse(readRepoFile(path)) as Crd
        return [crd.spec.names.kind, crd] as const
      }),
    )

    expect([...crds.keys()].sort()).toEqual([
      'Agent',
      'AgentProvider',
      'AgentRun',
      'Memory',
      'Orchestration',
      'OrchestrationRun',
    ])

    for (const [kind, crd] of crds) {
      expect(crd.spec.scope, `${kind} must remain namespace-scoped`).toBe('Namespaced')
      const examples = resources.filter((resource) => resource.kind === kind)
      expect(examples.length, `${kind} needs a complete YAML example`).toBeGreaterThan(0)

      for (const example of examples) {
        const versionName = example.apiVersion?.split('/').at(-1)
        const version = crd.spec.versions.find((candidate) => candidate.name === versionName)
        expect(version, `${kind} example must use a served CRD version`).toBeDefined()
        expect(example.apiVersion, `${kind} example must use the CRD API group`).toBe(
          `${crd.spec.group}/${versionName}`,
        )
        expect(isObject(example.spec), `${kind} example must define an object spec`).toBe(true)
        const specSchema = version?.schema.openAPIV3Schema.properties?.spec
        expect(specSchema, `${kind} CRD must expose a spec schema`).toBeDefined()
        validateValue(example.spec, specSchema!, `${kind}.spec`)
      }
    }
  })

  it('keeps operator-facing docs on the current service, delivery, and leader contracts', () => {
    const jangarPaths = [
      'docs/jangar/primitives/control-plane.md',
      'docs/jangar/primitives/production-validation.md',
      'scripts/jangar/validate-primitives.sh',
    ]
    const jangarDocs = jangarPaths
      .filter((path) => existsSync(join(repoRoot, path)))
      .map(readRepoFile)
      .join('\n')
    const runbook = readRepoFile('docs/agents/runbooks.md')
    const leaderElection = readRepoFile('docs/agents/leader-election-design.md')
    const agent = readRepoFile('docs/agents/primitives/agent.md')
    const agentctl = readRepoFile('docs/agents/agentctl-cli-design.md')
    const grpcServiceTemplate = readRepoFile('charts/agents/templates/service-grpc.yaml')
    const productionValues = readRepoFile('argocd/applications/agents/values.yaml')

    expect(jangarDocs).toContain('/v1/orchestration-runs')
    expect(jangarDocs).toContain('There is no `/v1/orchestration-executions` route')
    expect(jangarDocs.match(/\/v1\/orchestration-executions/g)).toHaveLength(1)
    expect(jangarDocs).not.toContain('from jangar_primitives.')
    expect(jangarDocs).not.toContain('MEMORY_SCHEMA="${MEMORY_SCHEMA:-jangar_primitives}"')
    expect(agent).not.toContain('deliveryId:')
    expect(runbook).toContain('kargo/agents')
    expect(runbook).toContain('lab-delivery')
    expect(runbook).toContain('orchestrations.orchestration.proompteng.ai')
    expect(runbook).not.toContain('orchestrations.agents.proompteng.ai')
    expect(runbook).not.toContain('Nitro')
    expect(leaderElection).toContain('agents-controller-leader')
    expect(leaderElection).toContain('agents_leader_changes_total')
    expect(leaderElection).not.toContain('jangar-controller-leader')
    expect(agentctl).toContain('agents-grpc.agents.svc.cluster.local:50051')
    expect(agentctl).toContain('`controllers.service.enabled`')
    expect(grpcServiceTemplate).toContain('{{- if .Values.grpc.enabled }}')
    expect(grpcServiceTemplate).toContain('{{ include "agents.fullname" . }}-grpc')
    expect(productionValues).toMatch(/^grpc:\n  enabled: true$/m)
  })

  it('keeps retired artifacts deleted and unreferenced from maintained documentation', () => {
    const documentation = listMarkdownFiles(join(repoRoot, 'docs'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    for (const path of retiredDocs) {
      expect(existsSync(join(repoRoot, path)), `${path} must stay retired`).toBe(false)
      expect(documentation, `${path} must not be referenced`).not.toContain(path)
      expect(documentation, `${path} basename must not be referenced`).not.toContain(path.split('/').at(-1)!)
    }
  })

  it('does not restore generated point-in-time audits as archive authority', () => {
    const authority = readRepoFile('docs/documentation-authority.md')
    const designs = [
      ...listMarkdownFiles(join(repoRoot, 'docs/agents/designs')),
      ...listMarkdownFiles(join(repoRoot, 'docs/torghut/design-system')),
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    expect(authority).toContain('references solely from another archive document')
    expect(designs).not.toContain('## Source Implementation Audit (2026-07-04)')
    expect(existsSync(join(repoRoot, 'docs/torghut/design-system/implementation-audit.md'))).toBe(false)
    expect(existsSync(join(repoRoot, 'docs/torghut/design-system/implementation-status-matrix-2026-02-21.md'))).toBe(
      false,
    )
  })

  it('runs the owning CI checks when maintained contract documents change', () => {
    const scriptsWorkflow = readRepoFile('.github/workflows/scripts-ci.yml')
    const agentctlWorkflow = readRepoFile('.github/workflows/agentctl-ci.yml')
    const jangarWorkflow = readRepoFile('.github/workflows/jangar-ci.yml')
    const impactMap = readRepoFile('.github/ci/impact-map.yml')

    for (const path of [
      "- 'docs/agents/primitives/**'",
      "- 'docs/jangar/primitives/**'",
      "- 'docs/agents/runbooks.md'",
      "- 'docs/agents/leader-election-design.md'",
      "- 'docs/agents/agentctl-cli-design.md'",
      "- 'docs/documentation-authority.md'",
    ]) {
      expect(scriptsWorkflow.split('\n').filter((line) => line.trim() === path)).toHaveLength(2)
    }

    expect(
      agentctlWorkflow.split('\n').filter((line) => line.trim() === "- 'docs/agents/agentctl-cli-design.md'"),
    ).toHaveLength(2)
    expect(jangarWorkflow).toContain("- 'docs/jangar/architecture-inventory.md'")
    for (const path of [
      "- 'services/agents/src/app-routes/**'",
      "- 'services/agents/src/components/control-plane/**'",
      "- 'services/agents/src/control-plane/**'",
      "- 'services/agents/src/routes/**'",
      "- 'services/agents/src/server/agents-controller/**'",
      "- 'services/agents/src/server/control-plane*.ts'",
      "- 'services/agents/src/server/v1/control-plane-*.ts'",
      "- 'services/agents/src/server/health.ts'",
      "- 'services/agents/src/server/orchestration-controller.ts'",
      "- '!services/agents/src/**/*.test.ts'",
    ]) {
      expect(jangarWorkflow).toContain(path)
    }
    expect(scriptsWorkflow.split('\n').filter((line) => line.trim() === "- 'scripts/jangar/**'")).toHaveLength(2)
    expect(scriptsWorkflow).toContain('bun test scripts/jangar/validate-primitives.test.ts')
    expect(impactMap).toContain('- docs/agents/agentctl-cli-design.md')
    expect(impactMap).toContain('- docs/jangar/architecture-inventory.md')
    expect(impactMap).toContain('- scripts/jangar/**')
  })
})
