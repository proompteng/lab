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
  it('applies chart deployment image repository, tag, and empty digest overrides', () => {
    const valuesFile = resolve(process.cwd(), 'scripts/agents/values-ci.yaml')
    const chartPath = resolve(process.cwd(), 'charts/agents')
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile,
      createNamespace: true,
      databaseUrl: 'postgresql://agents:pw@agents-postgres:5432/agents?sslmode=disable',
      imageRepository: 'agents-ci-local',
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
      'image.repository=agents-ci-local',
      '--set',
      'controlPlane.image.repository=agents-ci-local',
      '--set',
      'controllers.image.repository=agents-ci-local',
      '--set',
      'image.tag=latest',
      '--set',
      'controlPlane.image.tag=latest',
      '--set',
      'controllers.image.tag=latest',
      '--set',
      'image.digest=',
      '--set',
      'controlPlane.image.digest=',
      '--set',
      'controllers.image.digest=',
    ])
  })

  it('allows separate control-plane and controller image repositories', () => {
    const valuesFile = resolve(process.cwd(), 'scripts/agents/values-ci.yaml')
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile,
      createNamespace: false,
      imageRepository: 'agents-base-local',
      controlPlaneImageRepository: 'agents-control-plane-local',
      controllersImageRepository: 'agents-controller-local',
      imageTag: 'ci',
      imageDigestSet: false,
      imageDigest: '',
    })

    expect(args).toContain('image.repository=agents-base-local')
    expect(args).toContain('controlPlane.image.repository=agents-control-plane-local')
    expect(args).toContain('controllers.image.repository=agents-controller-local')
    expect(args).toContain('controlPlane.image.tag=ci')
    expect(args).toContain('controllers.image.tag=ci')
  })

  it('allows separate immutable control-plane and controller image pins', () => {
    const valuesFile = resolve(process.cwd(), 'scripts/agents/values-ci.yaml')
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile,
      createNamespace: false,
      controlPlaneImageRepository: 'registry.example/agents-control-plane',
      controllersImageRepository: 'registry.example/agents-controller',
      controlPlaneImageTag: 'control',
      controllersImageTag: 'controller',
      imageDigestSet: false,
      imageDigest: '',
      controlPlaneImageDigestSet: true,
      controlPlaneImageDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      controllersImageDigestSet: true,
      controllersImageDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    })

    expect(args).toContain('controlPlane.image.repository=registry.example/agents-control-plane')
    expect(args).toContain('controllers.image.repository=registry.example/agents-controller')
    expect(args).toContain('controlPlane.image.tag=control')
    expect(args).toContain('controllers.image.tag=controller')
    expect(args).toContain(
      'controlPlane.image.digest=sha256:1111111111111111111111111111111111111111111111111111111111111111',
    )
    expect(args).toContain(
      'controllers.image.digest=sha256:2222222222222222222222222222222222222222222222222222222222222222',
    )
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

  it('keeps domain admission env out of the Agents GitOps values while swarm primitive dispatch is disabled by default', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const controllers = objectAt(values, 'controllers')
    const env = objectAt(objectAt(controllers, 'env'), 'vars')
    const swarm = objectAt(values, 'swarm')

    expect(objectAt(swarm, 'enabled')).toBe(false)
    expect(objectAt(env, 'AGENTS_MATERIAL_REENTRY_REQUIREMENT_SIGNALS')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SCHEDULE_RUNNER_ADMISSION_STATUS_URL')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SWARM_REQUIREMENT_MAX_ACTIVE_PER_SWARM')).toBeUndefined()
  })

  it('renders Codex app-server adapter metadata instead of legacy provider wrapper scripts', () => {
    const manifests = readYamlObjects('argocd/applications/agents/codex-spark-agentprovider.yaml')
    const provider = manifests.find((manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'codex-spark')
    const spec = objectAt(provider, 'spec')
    const adapter = objectAt(spec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const envTemplate = objectAt(objectAt(provider, 'spec'), 'envTemplate')
    const inputFiles = objectAt(objectAt(provider, 'spec'), 'inputFiles') as Record<string, unknown>[] | undefined

    expect(objectAt(spec, 'binary')).toBe('/usr/local/bin/agent-runner')
    expect(objectAt(spec, 'argsTemplate')).toEqual([])
    expect(objectAt(adapter, 'type')).toBe('codex-app-server')
    expect(objectAt(codex, 'model')).toBe('gpt-5.5')
    expect(objectAt(codex, 'effort')).toBe('xhigh')
    expect(objectAt(codex, 'sandbox')).toBe('danger-full-access')
    expect(objectAt(codex, 'approval')).toBe('never')
    expect(objectAt(codex, 'cwd')).toBe('/workspace/lab')
    expect(objectAt(envTemplate, 'AGENT_RUN_NAME')).toBe('{{agentRun.name}}')
    expect(objectAt(envTemplate, 'AGENT_RUN_NAMESPACE')).toBe('{{agentRun.namespace}}')
    expect(objectAt(envTemplate, 'CODEX_MODEL_FALLBACKS')).toBe('gpt-5.4,gpt-5.4-mini,gpt-5.2-codex,gpt-5-codex')
    expect(objectAt(envTemplate, 'CODEX_MODEL_FALLBACKS')).not.toContain('gpt-5.3-codex-spark')
    expect(objectAt(envTemplate, 'CODEX_MAX_SESSION_ATTEMPTS')).toBe('5')
    expect((inputFiles ?? []).map((inputFile) => objectAt(inputFile, 'path'))).not.toContain(
      '/root/.codex/provider-codex-spark.json',
    )
    expect((inputFiles ?? []).map((inputFile) => objectAt(inputFile, 'path'))).not.toContain(
      '/root/.codex/sanitize-codex-log.py',
    )
    expect((inputFiles ?? []).map((inputFile) => objectAt(inputFile, 'path'))).not.toContain(
      '/root/.codex/swarm-hf-codex-fallback.py',
    )
  })
})

describe('kubectl error classification', () => {
  it('treats fresh-kind API resets as transient instead of RBAC failures', () => {
    const error = `E0306 08:40:45.536606   21508 memcache.go:265] couldn't get current server API group list: Get "https://127.0.0.1:45497/api?timeout=32s": read tcp 127.0.0.1:46302->127.0.0.1:45497: read: connection reset by peer - error from a previous attempt: read tcp 127.0.0.1:46300->127.0.0.1:45497: read: connection reset by peer
Error from server (Forbidden): unknown`

    expect(isTransientKubectlError(error)).toBe(true)
    expect(isPermissionDeniedKubectlError(error)).toBe(false)
  })

  it('treats kind etcd request timeouts during apply as transient', () => {
    const error = `Error from server: error when retrieving current configuration of:
Resource: "/v1, Resource=services", GroupVersionKind: "/v1, Kind=Service"
Name: "agents-ci-postgres", Namespace: "agents-ci"
from server for: "STDIN": etcdserver: request timed out`

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
