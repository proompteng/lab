import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const readYamlObjects = (path: string) =>
  parseAllDocuments(readFileSync(resolve(process.cwd(), path), 'utf8'))
    .map((document) => document.toJSON())
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')

const swarmAgentRunTemplatePaths = ['argocd/applications/torghut/agents-domain/torghut-swarm-agentrun-templates.yaml']

const swarmInstancePaths = ['argocd/applications/torghut/agents-domain/torghut-swarm-instances.yaml']

const swarmImplementationSpecPaths = ['argocd/applications/torghut/agents-domain/torghut-swarm-implspecs.yaml']

const stageContract = {
  discover: {
    role: 'architect',
    implementationSpecSuffix: 'swarm-intelligence-cycle-v1',
    vcsMode: 'read-write',
  },
  plan: {
    role: 'architect',
    implementationSpecSuffix: 'swarm-intelligence-cycle-v1',
    vcsMode: 'read-write',
  },
  implement: {
    role: 'engineer',
    implementationSpecSuffix: 'swarm-autonomous-implementation-v1',
    vcsMode: 'read-write',
  },
  verify: {
    role: 'deployer',
    implementationSpecSuffix: 'swarm-deployer-v1',
    vcsMode: 'read-write',
  },
} as const

const requiredCoordinationParameters = [
  'ownerChannel',
  'natsChannel',
  'natsSubjectPrefix',
  'swarmAgentIdentity',
  'swarmHumanName',
] as const

const requiredCollaborationTerms = ['nats collaboration', 'codex-nats-publish'] as const

const objectAt = (value: unknown, key: string) =>
  value && typeof value === 'object' ? ((value as Record<string, unknown>)[key] as unknown) : undefined

const stringAt = (value: unknown, key: string) => {
  const item = objectAt(value, key)
  return typeof item === 'string' ? item : ''
}

const nameOf = (manifest: Record<string, unknown>) => stringAt(objectAt(manifest, 'metadata'), 'name')

describe('Agents domain scheduled AgentRun templates', () => {
  it('keeps per-symbol market-context on-demand dispatch disabled in Jangar', () => {
    const deployment = readYamlObjects('argocd/applications/jangar/deployment.yaml').find(
      (manifest) => manifest.kind === 'Deployment' && nameOf(manifest) === 'jangar',
    )
    const spec = objectAt(deployment, 'spec')
    const template = objectAt(spec, 'template')
    const podSpec = objectAt(template, 'spec')
    const containers = objectAt(podSpec, 'containers')
    const appContainer = Array.isArray(containers)
      ? containers.find((container) => objectAt(container, 'name') === 'app')
      : undefined
    const env = objectAt(appContainer, 'env')
    const envMap = new Map(
      Array.isArray(env)
        ? env
            .map((entry) => [objectAt(entry, 'name'), objectAt(entry, 'value')])
            .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
        : [],
    )

    expect(envMap.get('JANGAR_MARKET_CONTEXT_ON_DEMAND_DISPATCH_ENABLED')).toBe('false')
  })

  it('does not schedule market-context refresh AgentRuns', () => {
    expect(
      existsSync(resolve(process.cwd(), 'argocd/applications/torghut/agents-domain/torghut-market-context-batch.yaml')),
    ).toBe(false)
    const manifests = readYamlObjects('argocd/applications/torghut/agents-domain/kustomization.yaml')
    const scheduleTargets = manifests
      .filter((manifest) => manifest.kind === 'Schedule')
      .map((schedule) => objectAt(objectAt(objectAt(schedule, 'spec'), 'targetRef'), 'name'))
      .sort()

    expect(scheduleTargets).toEqual([])
  })

  it('keeps retired market-context provider resources out of the agents domain', () => {
    const kustomization = readYamlObjects('argocd/applications/torghut/agents-domain/kustomization.yaml')[0]
    const resources = objectAt(kustomization, 'resources') as string[] | undefined

    expect(resources).not.toContain('torghut-market-context-agentprovider.yaml')
    expect(resources).not.toContain('torghut-market-context-priorityclass.yaml')
    expect(
      existsSync(
        resolve(process.cwd(), 'argocd/applications/torghut/agents-domain/torghut-market-context-agentprovider.yaml'),
      ),
    ).toBe(false)
    expect(
      existsSync(
        resolve(process.cwd(), 'argocd/applications/torghut/agents-domain/torghut-market-context-priorityclass.yaml'),
      ),
    ).toBe(false)
  })

  it('wires Torghut health reports to durable AgentRun artifacts', () => {
    const kustomization = readYamlObjects('argocd/applications/torghut/agents-domain/kustomization.yaml')[0]
    const resources = objectAt(kustomization, 'resources') as string[] | undefined
    expect(resources).toContain('torghut-health-agentprovider.yaml')
    expect(resources).toContain('torghut-health-agent.yaml')
    expect(resources).toContain('torghut-health-secretbinding.yaml')

    const provider = readYamlObjects(
      'argocd/applications/torghut/agents-domain/torghut-health-agentprovider.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentProvider')
    const providerSpec = objectAt(provider, 'spec')
    const adapter = objectAt(providerSpec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const secretEnv = objectAt(codex, 'secretEnv') as Record<string, unknown>[] | undefined
    const outputArtifacts = objectAt(providerSpec, 'outputArtifacts') as Record<string, unknown>[] | undefined
    const healthArtifact = outputArtifacts?.find((artifact) => objectAt(artifact, 'name') === 'torghut-health-report')

    expect(objectAt(objectAt(provider, 'metadata'), 'name')).toBe('torghut-health-report')
    expect(secretEnv).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'AGENTS_ARTIFACTS_ACCESS_KEY_ID',
          secretName: 'agents-artifacts',
          key: 'AWS_ACCESS_KEY_ID',
        }),
        expect.objectContaining({
          name: 'AGENTS_ARTIFACTS_SECRET_ACCESS_KEY',
          secretName: 'agents-artifacts',
          key: 'AWS_SECRET_ACCESS_KEY',
        }),
      ]),
    )
    expect(objectAt(objectAt(providerSpec, 'envTemplate'), 'AGENTS_ARTIFACTS_ENDPOINT')).toBe(
      'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80',
    )
    expect(healthArtifact).toEqual({
      name: 'torghut-health-report',
      path: '/workspace/.agentrun/torghut-health/report.md',
      key: 'torghut/health/{{ agentRun.name }}/report.md',
    })

    const agent = readYamlObjects('argocd/applications/torghut/agents-domain/torghut-health-agent.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'Agent',
    )
    expect(objectAt(objectAt(objectAt(agent, 'spec'), 'providerRef'), 'name')).toBe('torghut-health-report')

    const secretBinding = readYamlObjects(
      'argocd/applications/torghut/agents-domain/torghut-health-secretbinding.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'SecretBinding')
    const allowedSecrets = objectAt(objectAt(secretBinding, 'spec'), 'allowedSecrets') as string[] | undefined
    expect(allowedSecrets).toEqual(expect.arrayContaining(['codex-auth', 'agents-artifacts']))

    const healthSpec = readYamlObjects('argocd/applications/torghut/agents-domain/torghut-agentruns.yaml').find(
      (manifest) =>
        objectAt(manifest, 'kind') === 'ImplementationSpec' && nameOf(manifest) === 'torghut-health-report-v1',
    )
    const healthText = stringAt(objectAt(healthSpec, 'spec'), 'text')
    expect(healthText).toContain('/workspace/.agentrun/torghut-health/report.md')
    expect(healthText).toContain('Do not finish until that Markdown report file exists')
  })

  it('keeps scheduled template retention aligned with the swarm brownout window', () => {
    const manifestPaths = [...swarmAgentRunTemplatePaths, ...swarmInstancePaths]
    const manifests = manifestPaths.flatMap(readYamlObjects)
    const scheduledTemplateNames = new Set<string>()
    for (const schedule of manifests.filter((manifest) => manifest.kind === 'Schedule')) {
      const name = objectAt(objectAt(objectAt(schedule, 'spec'), 'targetRef'), 'name')
      if (typeof name === 'string' && name.endsWith('-template')) {
        scheduledTemplateNames.add(name)
      }
    }
    for (const swarm of manifests.filter((manifest) => manifest.kind === 'Swarm')) {
      const execution = objectAt(objectAt(swarm, 'spec'), 'execution')
      if (!execution || typeof execution !== 'object') continue
      for (const stage of Object.values(execution)) {
        const name = objectAt(objectAt(stage, 'targetRef'), 'name')
        if (typeof name === 'string' && name.endsWith('-template')) {
          scheduledTemplateNames.add(name)
        }
      }
    }
    const agentRunTemplates = new Map(
      manifests
        .filter((manifest) => manifest.kind === 'AgentRun')
        .map((agentRun) => [objectAt(objectAt(agentRun, 'metadata'), 'name'), agentRun])
        .filter((entry): entry is [string, Record<string, unknown>] => typeof entry[0] === 'string'),
    )

    expect([...scheduledTemplateNames].sort()).toEqual([...agentRunTemplates.keys()].sort())
    for (const name of scheduledTemplateNames) {
      const template = agentRunTemplates.get(name)
      expect(objectAt(objectAt(template, 'spec'), 'ttlSecondsAfterFinished')).toBe(21_600)
      expect(objectAt(objectAt(objectAt(template, 'metadata'), 'annotations'), 'agents.proompteng.ai/template')).toBe(
        'true',
      )
    }
  })

  it('keeps scheduled verify runs bounded to one release slice per cadence', () => {
    const manifests = swarmAgentRunTemplatePaths.flatMap(readYamlObjects)
    const agentRunTemplates = new Map(
      manifests
        .filter((manifest) => manifest.kind === 'AgentRun')
        .map((agentRun) => [objectAt(objectAt(agentRun, 'metadata'), 'name'), agentRun])
        .filter((entry): entry is [string, Record<string, unknown>] => typeof entry[0] === 'string'),
    )

    for (const name of ['torghut-swarm-verify-template']) {
      const template = agentRunTemplates.get(name)
      const workflow = objectAt(objectAt(template, 'spec'), 'workflow')
      const steps = objectAt(workflow, 'steps') as Record<string, unknown>[] | undefined
      const verifyStep = steps?.find((step) => objectAt(step, 'name') === 'verify')

      expect(objectAt(verifyStep, 'retries')).toBe(0)
      expect(objectAt(verifyStep, 'timeoutSeconds')).toBe(7200)
    }
  })

  it('wires scheduled swarm runs to live business evidence surfaces', () => {
    const manifests = swarmAgentRunTemplatePaths.flatMap(readYamlObjects)
    const agentRunTemplates = new Map(
      manifests
        .filter((manifest) => manifest.kind === 'AgentRun')
        .map((agentRun) => [objectAt(objectAt(agentRun, 'metadata'), 'name'), agentRun])
        .filter((entry): entry is [string, Record<string, unknown>] => typeof entry[0] === 'string'),
    )

    for (const [name, expectedUrl] of [
      ['torghut-swarm-discover-template', 'http://torghut.torghut.svc.cluster.local/trading/revenue-repair'],
      ['torghut-swarm-plan-template', 'http://torghut.torghut.svc.cluster.local/trading/revenue-repair'],
      ['torghut-swarm-implement-template', 'http://torghut.torghut.svc.cluster.local/trading/revenue-repair'],
      ['torghut-swarm-verify-template', 'http://torghut.torghut.svc.cluster.local/trading/revenue-repair'],
    ] as const) {
      const template = agentRunTemplates.get(name)
      const parameters = objectAt(objectAt(template, 'spec'), 'parameters')

      expect(objectAt(parameters, 'swarmBusinessEvidenceUrl')).toBe(expectedUrl)
    }
  })

  it('mounts HF fallback secrets for Codex-backed swarm templates', () => {
    const manifests = swarmAgentRunTemplatePaths.flatMap(readYamlObjects)
    const agentRunTemplates = manifests.filter((manifest) => manifest.kind === 'AgentRun')

    for (const template of agentRunTemplates) {
      const name = objectAt(objectAt(template, 'metadata'), 'name')
      const agentRef = objectAt(objectAt(objectAt(template, 'spec'), 'agentRef'), 'name')
      if (typeof name !== 'string' || agentRef !== 'codex-spark-agent') continue
      const secrets = objectAt(objectAt(template, 'spec'), 'secrets') as string[] | undefined

      expect(secrets).toContain('github-token')
      expect(secrets).toContain('codex-auth')
      expect(secrets).toContain('hf-router-token')
      expect(secrets).toContain('nats-agents-credentials')
    }

    const secretBindings = readYamlObjects('argocd/applications/agents/codex-secretbinding.yaml')
    const codexBinding = secretBindings.find(
      (manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'codex-github-token',
    )
    const allowedSecrets = objectAt(objectAt(codexBinding, 'spec'), 'allowedSecrets') as string[] | undefined

    expect(allowedSecrets).toContain('hf-router-token')
    expect(allowedSecrets).toContain('nats-agents-credentials')
  })

  it('keeps the deployer implementation spec focused on a bounded release slice', () => {
    const manifests = swarmImplementationSpecPaths.flatMap(readYamlObjects)
    const torghutDeployerSpec = manifests.find(
      (manifest) =>
        manifest.kind === 'ImplementationSpec' &&
        objectAt(objectAt(manifest, 'metadata'), 'name') === 'torghut-swarm-deployer-v1',
    )
    const torghutText = stringAt(objectAt(torghutDeployerSpec, 'spec'), 'text')

    expect(torghutText).toContain('Select at most one unblock-first/high-impact PR')
    expect(torghutText).toContain('Ignore or close superseded release/promotion PRs')
    expect(torghutText).toContain('Do not use GitHub comments for routine status')
    expect(torghutText).toContain('Never request Codex review automatically')
    expect(torghutText).toContain('/trading/revenue-repair')
    expect(torghutText).not.toContain('codex:review-request')
  })

  it('requires implementation runs to use live business evidence before selecting work', () => {
    const manifests = swarmImplementationSpecPaths.flatMap(readYamlObjects)
    const torghutImplementerSpec = manifests.find(
      (manifest) =>
        manifest.kind === 'ImplementationSpec' &&
        objectAt(objectAt(manifest, 'metadata'), 'name') === 'torghut-swarm-autonomous-implementation-v1',
    )
    const torghutText = stringAt(objectAt(torghutImplementerSpec, 'spec'), 'text')

    expect(torghutText).toContain('Read `${swarmBusinessEvidenceUrl}` when provided')
    expect(torghutText).toContain('If the remote `${head}` branch is absent')
    expect(torghutText).toContain('top actionable `repair_queue` item')
    expect(torghutText).toContain('do not enable live submission while `business_state=repair_only`')
  })

  it('keeps the Torghut swarm three-role execution contract domain-owned', () => {
    const templates = new Map(
      swarmAgentRunTemplatePaths
        .flatMap(readYamlObjects)
        .filter((manifest) => manifest.kind === 'AgentRun')
        .map((manifest) => [nameOf(manifest), manifest])
        .filter((entry): entry is [string, Record<string, unknown>] => entry[0].length > 0),
    )
    const implementationSpecs = new Map(
      swarmImplementationSpecPaths
        .flatMap(readYamlObjects)
        .filter((manifest) => manifest.kind === 'ImplementationSpec')
        .map((manifest) => [nameOf(manifest), manifest])
        .filter((entry): entry is [string, Record<string, unknown>] => entry[0].length > 0),
    )
    const swarms = swarmInstancePaths.flatMap(readYamlObjects).filter((manifest) => manifest.kind === 'Swarm')
    const errors: string[] = []

    if (swarms.length === 0) {
      errors.push('domain swarm manifests must define at least one Swarm')
    }

    for (const [implementationSpecName, implementationSpec] of implementationSpecs) {
      const implementationSpecText = stringAt(objectAt(implementationSpec, 'spec'), 'text').toLowerCase()
      for (const requiredTerm of requiredCollaborationTerms) {
        if (!implementationSpecText.includes(requiredTerm)) {
          errors.push(`${implementationSpecName}: missing required collaboration term ${requiredTerm}`)
        }
      }
      if (
        implementationSpecName.startsWith('torghut-') &&
        implementationSpecText.includes('jangar is the visibility surface')
      ) {
        errors.push(`${implementationSpecName}: Torghut swarm specs must not require Jangar as the visibility surface`)
      }
    }

    for (const swarm of swarms) {
      const swarmName = nameOf(swarm)
      const execution = objectAt(objectAt(swarm, 'spec'), 'execution')
      for (const [stage, expected] of Object.entries(stageContract)) {
        const stageConfig = objectAt(execution, stage)
        const targetName = stringAt(objectAt(stageConfig, 'targetRef'), 'name')
        if (!targetName) {
          errors.push(`${swarmName}: spec.execution.${stage}.targetRef.name is required`)
          continue
        }

        const template = templates.get(targetName)
        if (!template) {
          errors.push(`${swarmName}: ${stage} target AgentRun template ${targetName} not found`)
          continue
        }

        const templateSpec = objectAt(template, 'spec')
        const parameters = objectAt(templateSpec, 'parameters')
        for (const parameterName of requiredCoordinationParameters) {
          const parameterValue = stringAt(parameters, parameterName)
          if (!parameterValue.trim()) {
            errors.push(`${targetName}: missing required coordination parameter ${parameterName}`)
          }
        }

        const role = stringAt(parameters, 'swarmAgentRole')
        if (role !== expected.role) {
          errors.push(`${targetName}: expected swarmAgentRole ${expected.role}, found ${role}`)
        }

        const implementationSpecName = stringAt(objectAt(templateSpec, 'implementationSpecRef'), 'name')
        if (!implementationSpecs.has(implementationSpecName)) {
          errors.push(`${targetName}: implementationSpecRef ${implementationSpecName} not found`)
        } else if (!implementationSpecName.endsWith(expected.implementationSpecSuffix)) {
          errors.push(
            `${targetName}: expected implementationSpecRef suffix ${expected.implementationSpecSuffix}, found ${implementationSpecName}`,
          )
        }

        const vcsMode = stringAt(objectAt(templateSpec, 'vcsPolicy'), 'mode')
        if (vcsMode !== expected.vcsMode) {
          errors.push(`${targetName}: expected vcsPolicy.mode ${expected.vcsMode}, found ${vcsMode}`)
        }

        const objective = stringAt(parameters, 'objective').toLowerCase()
        if (stage === 'verify' && !['release engineer', 'merge', 'rollout'].every((term) => objective.includes(term))) {
          errors.push(`${targetName}: deployer objective must cover release engineering, merge, and rollout`)
        }
      }
    }

    expect(errors).toEqual([])
  })
})
