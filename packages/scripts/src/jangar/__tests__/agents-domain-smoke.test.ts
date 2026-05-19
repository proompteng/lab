import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const readYamlObjects = (path: string) =>
  parseAllDocuments(readFileSync(resolve(process.cwd(), path), 'utf8'))
    .map((document) => document.toJSON())
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')

const swarmAgentRunTemplatePaths = [
  'argocd/applications/jangar-agents-domain/jangar-swarm-agentrun-templates.yaml',
  'argocd/applications/torghut/agents-domain/torghut-swarm-agentrun-templates.yaml',
]

const swarmInstancePaths = [
  'argocd/applications/jangar-agents-domain/jangar-swarm-instances.yaml',
  'argocd/applications/torghut/agents-domain/torghut-swarm-instances.yaml',
]

const swarmImplementationSpecPaths = [
  'argocd/applications/jangar-agents-domain/jangar-swarm-implspecs.yaml',
  'argocd/applications/torghut/agents-domain/torghut-swarm-implspecs.yaml',
]

const objectAt = (value: unknown, key: string) =>
  value && typeof value === 'object' ? ((value as Record<string, unknown>)[key] as unknown) : undefined

const stringAt = (value: unknown, key: string) => {
  const item = objectAt(value, key)
  return typeof item === 'string' ? item : ''
}

describe('Agents domain scheduled AgentRun templates', () => {
  it('keeps scheduled template retention aligned with the swarm brownout window', () => {
    const manifestPaths = [
      ...swarmAgentRunTemplatePaths,
      ...swarmInstancePaths,
      'argocd/applications/torghut/agents-domain/torghut-market-context-batch.yaml',
    ]
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

    for (const name of ['jangar-swarm-verify-template', 'torghut-swarm-verify-template']) {
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
      ['jangar-swarm-discover-template', 'http://agents.agents.svc.cluster.local/ready'],
      ['jangar-swarm-plan-template', 'http://agents.agents.svc.cluster.local/ready'],
      ['jangar-swarm-implement-template', 'http://agents.agents.svc.cluster.local/ready'],
      ['jangar-swarm-verify-template', 'http://agents.agents.svc.cluster.local/ready'],
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
    const jangarDeployerSpec = manifests.find(
      (manifest) =>
        manifest.kind === 'ImplementationSpec' &&
        objectAt(objectAt(manifest, 'metadata'), 'name') === 'jangar-swarm-deployer-v1',
    )
    const torghutText = stringAt(objectAt(torghutDeployerSpec, 'spec'), 'text')
    const jangarText = stringAt(objectAt(jangarDeployerSpec, 'spec'), 'text')

    expect(torghutText).toContain('Select at most one unblock-first/high-impact PR')
    expect(torghutText).toContain('Ignore or close superseded release/promotion PRs')
    expect(torghutText).toContain('Do not use GitHub comments for routine status')
    expect(torghutText).toContain('Never request Codex review automatically')
    expect(torghutText).toContain('/trading/revenue-repair')
    expect(torghutText).not.toContain('codex:review-request')
    expect(jangarText).toContain('Select at most one unblock-first/high-impact PR')
    expect(jangarText).not.toContain('/trading/revenue-repair')
  })

  it('requires implementation runs to use live business evidence before selecting work', () => {
    const manifests = swarmImplementationSpecPaths.flatMap(readYamlObjects)
    const torghutImplementerSpec = manifests.find(
      (manifest) =>
        manifest.kind === 'ImplementationSpec' &&
        objectAt(objectAt(manifest, 'metadata'), 'name') === 'torghut-swarm-autonomous-implementation-v1',
    )
    const jangarImplementerSpec = manifests.find(
      (manifest) =>
        manifest.kind === 'ImplementationSpec' &&
        objectAt(objectAt(manifest, 'metadata'), 'name') === 'jangar-swarm-autonomous-implementation-v1',
    )
    const torghutText = stringAt(objectAt(torghutImplementerSpec, 'spec'), 'text')
    const jangarText = stringAt(objectAt(jangarImplementerSpec, 'spec'), 'text')

    expect(torghutText).toContain('Read `${swarmBusinessEvidenceUrl}` when provided')
    expect(torghutText).toContain('If the remote `${head}` branch is absent')
    expect(torghutText).toContain('top actionable `repair_queue` item')
    expect(torghutText).toContain('do not enable live submission while `business_state=repair_only`')
    expect(jangarText).toContain('Read `${swarmBusinessEvidenceUrl}` when provided')
    expect(jangarText).not.toContain('top actionable `repair_queue` item')
  })
})
