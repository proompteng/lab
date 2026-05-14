import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

import {
  buildHelmArgs,
  buildPodHealthProbeArgs,
  buildPostgresBootstrapManifest,
  buildPostgresExtensionArgs,
  createSmokeFailure,
  buildKubectlApplyArgs,
  buildKubectlApplyCrdsArgs,
  buildKubectlWaitForCrdsArgs,
  defaultPostgresImage,
  isPermissionDeniedKubectlError,
  isTransientKubectlError,
} from '../smoke-agents'

describe('buildHelmArgs', () => {
  it('applies image repository, tag, and empty digest overrides', () => {
    const valuesFile = resolve(process.cwd(), 'scripts/agents/values-ci.yaml')
    const chartPath = resolve(process.cwd(), 'charts/agents')
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile,
      createNamespace: true,
      databaseUrl: 'postgresql://agents:pw@agents-postgres:5432/agents?sslmode=disable',
      imageRepository: 'ghcr.io/proompteng/jangar',
      imageTag: 'latest',
      imageDigestSet: true,
      imageDigest: '',
    })

    expect(args).toEqual([
      'upgrade',
      '--install',
      'agents',
      chartPath,
      '--namespace',
      'agents-ci',
      '--values',
      valuesFile,
      '--skip-crds',
      '--create-namespace',
      '--set-string',
      'database.url=postgresql://agents:pw@agents-postgres:5432/agents?sslmode=disable',
      '--set',
      'image.repository=ghcr.io/proompteng/jangar',
      '--set',
      'image.tag=latest',
      '--set',
      'image.digest=',
    ])
  })

  it('omits image digest when the env key is unset', () => {
    const valuesFile = resolve(process.cwd(), 'charts/agents/values-local.yaml')
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents',
      valuesFile,
      createNamespace: false,
      imageDigestSet: false,
      imageDigest: '',
    })

    expect(args).not.toContain('image.digest=')
    expect(args).not.toContain('--create-namespace')
  })
})

describe('buildKubectlApplyArgs', () => {
  it('disables validation for runtime-generated stdin manifests', () => {
    expect(buildKubectlApplyArgs({ namespace: 'agents-ci' })).toEqual([
      '-n',
      'agents-ci',
      'apply',
      '--validate=false',
      '-f',
      '-',
    ])
  })

  it('disables validation for file-based smoke manifests', () => {
    expect(
      buildKubectlApplyArgs({
        namespace: 'agents-ci',
        file: resolve(process.cwd(), 'charts/agents/examples/agent-smoke.yaml'),
      }),
    ).toEqual([
      '-n',
      'agents-ci',
      'apply',
      '--validate=false',
      '-f',
      resolve(process.cwd(), 'charts/agents/examples/agent-smoke.yaml'),
    ])
  })
})

describe('CRD bootstrap kubectl args', () => {
  it('applies the chart CRD directory before helm install', () => {
    expect(buildKubectlApplyCrdsArgs()).toEqual(['apply', '-f', resolve(process.cwd(), 'charts/agents/crds')])
  })

  it('waits for chart CRDs to become established', () => {
    expect(buildKubectlWaitForCrdsArgs()).toEqual([
      'wait',
      '--for=condition=Established',
      '--timeout=120s',
      '-f',
      resolve(process.cwd(), 'charts/agents/crds'),
    ])
  })

  it('supports a custom CRD wait timeout', () => {
    expect(buildKubectlWaitForCrdsArgs('45s')).toEqual([
      'wait',
      '--for=condition=Established',
      '--timeout=45s',
      '-f',
      resolve(process.cwd(), 'charts/agents/crds'),
    ])
  })
})

describe('buildPodHealthProbeArgs', () => {
  it('execs into the pod and fetches the readiness endpoint with node or bun', () => {
    const args = buildPodHealthProbeArgs('agents-ci', 'agents-ci-abc123')
    expect(args).toEqual([
      'kubectl',
      '-n',
      'agents-ci',
      'exec',
      'agents-ci-abc123',
      '--',
      'sh',
      '-lc',
      expect.stringContaining('http://127.0.0.1:8080/health'),
    ])
    expect(args[8]).toContain('\nelif command -v bun >/dev/null 2>&1; then\n')
    expect(args[8]).toContain('\nfi')
    expect(args[8]).not.toContain('`status=')
  })
})

describe('postgres smoke bootstrap', () => {
  it('uses a mirrored pgvector image and a bounded rollout deadline', () => {
    const manifests = parseAllDocuments(
      buildPostgresBootstrapManifest({
        dbHost: 'agents-ci-postgres',
        dbPort: '5432',
        dbImage: defaultPostgresImage,
        dbUser: 'agents',
        dbPassword: 'secret',
        dbName: 'agents',
      }),
    ).map((document) => document.toJSON()) as Record<string, unknown>[]

    const deployment = manifests.find((manifest) => manifest.kind === 'Deployment')
    const spec = objectAt(deployment, 'spec') as Record<string, unknown>
    const podSpec = objectAt(objectAt(objectAt(spec, 'template'), 'spec'), 'containers') as Record<string, unknown>[]

    expect(defaultPostgresImage).toBe('mirror.gcr.io/pgvector/pgvector:pg16')
    expect(objectAt(spec, 'progressDeadlineSeconds')).toBe(180)
    expect(objectAt(podSpec[0], 'image')).toBe(defaultPostgresImage)
    expect(objectAt(podSpec[0], 'imagePullPolicy')).toBe('IfNotPresent')
  })

  it('execs Postgres extension setup in the selected namespace', () => {
    expect(buildPostgresExtensionArgs('agents-ci', 'agents-ci-postgres-abc', 'agents', 'agents')).toEqual([
      'kubectl',
      '-n',
      'agents-ci',
      'exec',
      'agents-ci-postgres-abc',
      '--',
      'psql',
      '-U',
      'agents',
      '-d',
      'agents',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    ])
  })
})

describe('smoke fixtures', () => {
  it('keeps the smoke agent fixture aligned with the system prompt policy', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'charts/agents/examples/agent-smoke.yaml'), 'utf8')

    expect(fixture).toContain('defaults:')
    expect(fixture).toContain('systemPrompt:')
  })

  it('keeps workflow smoke workload pulls off Docker Hub', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'charts/agents/examples/agentrun-workflow-smoke.yaml'), 'utf8')

    expect(fixture).toContain('image: mirror.gcr.io/library/busybox:1.36')
    expect(fixture).not.toContain('image: busybox:')
  })
})

const readYamlObjects = (path: string) =>
  parseAllDocuments(readFileSync(resolve(process.cwd(), path), 'utf8'))
    .map((document) => document.toJSON())
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')

const objectAt = (value: unknown, key: string) =>
  value && typeof value === 'object' ? ((value as Record<string, unknown>)[key] as unknown) : undefined

describe('scheduled AgentRun templates', () => {
  it('configures default runner resource requests for swarm jobs', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const controller = objectAt(values, 'controller')
    const defaultWorkload = objectAt(controller, 'defaultWorkload')
    const resources = objectAt(defaultWorkload, 'resources')
    const requests = objectAt(resources, 'requests')
    const limits = objectAt(resources, 'limits')

    expect(objectAt(requests, 'cpu')).toBe('1')
    expect(objectAt(requests, 'memory')).toBe('4Gi')
    expect(objectAt(requests, 'ephemeral-storage')).toBe('8Gi')
    expect(objectAt(limits, 'memory')).toBe('16Gi')
    expect(objectAt(limits, 'ephemeral-storage')).toBe('16Gi')
  })

  it('keeps material reentry status reads bounded while requirement signal floods are disabled', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const controllers = objectAt(values, 'controllers')
    const env = objectAt(objectAt(controllers, 'env'), 'vars')
    const timeoutMs = Number(objectAt(env, 'JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS'))

    expect(objectAt(env, 'JANGAR_MATERIAL_REENTRY_REQUIREMENT_SIGNALS')).toBe('false')
    expect(objectAt(env, 'JANGAR_SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE')).toBe('1')
    expect(objectAt(env, 'JANGAR_SWARM_REQUIREMENT_MAX_ACTIVE_PER_SWARM')).toBe('2')
    expect(timeoutMs).toBeGreaterThanOrEqual(10_000)
  })

  it('disable retention so schedules can always resolve their template targets', () => {
    const manifestPaths = [
      'argocd/applications/agents/swarm-agentrun-templates.yaml',
      'argocd/applications/agents/swarm-instances.yaml',
      'argocd/applications/agents/torghut-market-context-batch.yaml',
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
      expect(objectAt(objectAt(template, 'spec'), 'ttlSecondsAfterFinished')).toBe(0)
      expect(objectAt(objectAt(objectAt(template, 'metadata'), 'annotations'), 'agents.proompteng.ai/template')).toBe(
        'true',
      )
    }
  })

  it('keeps scheduled verify runs bounded to one release slice per cadence', () => {
    const manifests = readYamlObjects('argocd/applications/agents/swarm-agentrun-templates.yaml')
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
    const manifests = readYamlObjects('argocd/applications/agents/swarm-agentrun-templates.yaml')
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

  it('keeps the deployer implementation spec focused on a bounded release slice', () => {
    const manifests = readYamlObjects('argocd/applications/agents/swarm-implspecs.yaml')
    const deployerSpec = manifests.find(
      (manifest) =>
        manifest.kind === 'ImplementationSpec' &&
        objectAt(objectAt(manifest, 'metadata'), 'name') === 'swarm-deployer-v1',
    )
    const text = String(objectAt(objectAt(deployerSpec, 'spec'), 'text') ?? '')

    expect(text).toContain('Select at most one unblock-first/high-impact PR')
    expect(text).toContain('Ignore or close superseded release/promotion PRs')
    expect(text).toContain('Do not use GitHub comments for routine status')
    expect(text).toContain('Never request Codex review automatically')
    expect(text).toContain('/trading/revenue-repair')
    expect(text).not.toContain('codex:review-request')
  })

  it('requires implementation runs to use live business evidence before selecting work', () => {
    const manifests = readYamlObjects('argocd/applications/agents/swarm-implspecs.yaml')
    const implementerSpec = manifests.find(
      (manifest) =>
        manifest.kind === 'ImplementationSpec' &&
        objectAt(objectAt(manifest, 'metadata'), 'name') === 'swarm-autonomous-implementation-v1',
    )
    const text = String(objectAt(objectAt(implementerSpec, 'spec'), 'text') ?? '')

    expect(text).toContain('Read `${swarmBusinessEvidenceUrl}` when provided')
    expect(text).toContain('If the remote `${head}` branch is absent')
    expect(text).toContain('top actionable `repair_queue` item')
    expect(text).toContain('do not enable live submission while `business_state=repair_only`')
  })
})

describe('kubectl error classification', () => {
  it('treats fresh-kind API resets as transient instead of RBAC failures', () => {
    const error = `E0306 08:40:45.536606   21508 memcache.go:265] couldn't get current server API group list: Get "https://127.0.0.1:45497/api?timeout=32s": read tcp 127.0.0.1:46302->127.0.0.1:45497: read: connection reset by peer - error from a previous attempt: read tcp 127.0.0.1:46300->127.0.0.1:45497: read: connection reset by peer
Error from server (Forbidden): unknown`

    expect(isTransientKubectlError(error)).toBe(true)
    expect(isPermissionDeniedKubectlError(error)).toBe(false)
  })

  it('keeps real namespace RBAC denials classified as permission errors', () => {
    const error =
      'Error from server (Forbidden): namespaces is forbidden: User "system:serviceaccount:agents:agents-sa" cannot get resource "namespaces" in API group "" at the cluster scope'

    expect(isTransientKubectlError(error)).toBe(false)
    expect(isPermissionDeniedKubectlError(error)).toBe(true)
  })
})

describe('createSmokeFailure', () => {
  it('returns a catchable error instead of exiting the process', () => {
    expect(() => {
      throw createSmokeFailure('Timed out waiting for 2 job(s).')
    }).toThrow('Timed out waiting for 2 job(s).')
  })

  it('includes nested error detail in the message', () => {
    expect(createSmokeFailure('Smoke test failed', new Error('job list command failed')).message).toBe(
      'Smoke test failed\njob list command failed',
    )
  })
})
