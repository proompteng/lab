import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

import {
  buildHelmArgs,
  buildPodHealthProbeArgs,
  createSmokeFailure,
  defaultSmokeDatabaseImage,
  buildKubectlApplyArgs,
  buildKubectlApplyCrdsArgs,
  buildKubectlWaitForCrdsArgs,
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

describe('smoke database image', () => {
  it('uses the Google registry mirror for pgvector by default', () => {
    expect(defaultSmokeDatabaseImage).toBe('mirror.gcr.io/pgvector/pgvector:pg16')
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

describe('smoke fixtures', () => {
  it('keeps the smoke agent fixture aligned with the system prompt policy', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'charts/agents/examples/agent-smoke.yaml'), 'utf8')

    expect(fixture).toContain('defaults:')
    expect(fixture).toContain('systemPrompt:')
  })

  it('keeps the workflow smoke workload off Docker Hub', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'charts/agents/examples/agentrun-workflow-smoke.yaml'), 'utf8')

    expect(fixture).toContain('image: mirror.gcr.io/library/busybox:1.36')
    expect(fixture).not.toContain('image: busybox:1.36')
  })
})

const readYamlObjects = (path: string) =>
  parseAllDocuments(readFileSync(resolve(process.cwd(), path), 'utf8'))
    .map((document) => document.toJSON())
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')

const objectAt = (value: unknown, key: string) =>
  value && typeof value === 'object' ? ((value as Record<string, unknown>)[key] as unknown) : undefined

describe('scheduled AgentRun templates', () => {
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
