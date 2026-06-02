import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
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
      '--set-string',
      'image.tag=latest',
      '--set-string',
      'controlPlane.image.tag=latest',
      '--set-string',
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

  it('allows a separate runner image pin for AgentRun jobs', () => {
    const valuesFile = resolve(process.cwd(), 'scripts/agents/values-ci.yaml')
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile,
      createNamespace: false,
      imageRepository: 'registry.example/agents-control-plane',
      controlPlaneImageRepository: 'registry.example/agents-control-plane',
      controllersImageRepository: 'registry.example/agents-controller',
      runnerImageRepository: 'registry.example/agents-codex-runner',
      imageTag: 'ci',
      runnerImageTag: 'runner-ci',
      imageDigestSet: false,
      imageDigest: '',
      runnerImageDigestSet: true,
      runnerImageDigest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    })

    expect(args).toContain('runner.image.repository=registry.example/agents-codex-runner')
    expect(args).toContain('runner.image.tag=runner-ci')
    expect(args).toContain(
      'runner.image.digest=sha256:3333333333333333333333333333333333333333333333333333333333333333',
    )
  })

  it('passes numeric-looking published image tags as strings for Helm schema validation', () => {
    const valuesFile = resolve(process.cwd(), 'scripts/agents/values-ci.yaml')
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile,
      createNamespace: false,
      controlPlaneImageRepository: 'registry.example/agents-control-plane',
      controllersImageRepository: 'registry.example/agents-controller',
      runnerImageRepository: 'registry.example/agents-codex-runner',
      controlPlaneImageTag: '80403146',
      controllersImageTag: '80403146',
      runnerImageTag: '80403146',
      imageDigestSet: false,
      imageDigest: '',
    })

    expect(args).toContain('--set-string')
    expect(
      args.slice(
        args.indexOf('controlPlane.image.tag=80403146') - 1,
        args.indexOf('controlPlane.image.tag=80403146') + 1,
      ),
    ).toEqual(['--set-string', 'controlPlane.image.tag=80403146'])
    expect(
      args.slice(
        args.indexOf('controllers.image.tag=80403146') - 1,
        args.indexOf('controllers.image.tag=80403146') + 1,
      ),
    ).toEqual(['--set-string', 'controllers.image.tag=80403146'])
    expect(
      args.slice(args.indexOf('runner.image.tag=80403146') - 1, args.indexOf('runner.image.tag=80403146') + 1),
    ).toEqual(['--set-string', 'runner.image.tag=80403146'])
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

  it('keeps workflow smoke on the chart-managed runner image', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'charts/agents/examples/agentrun-workflow-smoke.yaml'), 'utf8')

    expect(fixture).toContain('workload:')
    expect(fixture).toContain('resources:')
    expect(fixture).not.toMatch(/image:\s*(busybox|mirror\.gcr\.io\/library\/busybox)/)
  })
})

const readYamlObjects = (path: string) =>
  parseAllDocuments(readFileSync(resolve(process.cwd(), path), 'utf8'))
    .map((document) => document.toJSON())
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')

const objectAt = (value: unknown, key: string) =>
  value && typeof value === 'object' ? ((value as Record<string, unknown>)[key] as unknown) : undefined

describe('scheduled AgentRun templates', () => {
  it('enables the CI controller deployment so workflow smoke AgentRuns are reconciled', () => {
    const values = readYamlObjects('scripts/agents/values-ci.yaml')[0]
    const controllers = objectAt(values, 'controllers')

    expect(objectAt(controllers, 'enabled')).toBe(true)
  })

  it('requires every checked-in AgentProvider fixture to declare a normalized adapter', () => {
    const agentProviderFiles = [
      'argocd/applications/agents/agents-primitives-agentprovider.yaml',
      'argocd/applications/agents/codex-agentprovider.yaml',
      'argocd/applications/agents/codex-spark-agentprovider.yaml',
      'argocd/applications/agents/codex-spark-smoke-agentprovider.yaml',
      'argocd/applications/agents/graf-codex-agentprovider.yaml',
      'charts/agents/examples/agentprovider-native-workflow.yaml',
      'charts/agents/examples/agentprovider-sample.yaml',
      'charts/agents/examples/agentprovider-smoke.yaml',
    ]

    for (const path of agentProviderFiles) {
      const provider = readYamlObjects(path).find((manifest) => objectAt(manifest, 'kind') === 'AgentProvider')
      const spec = objectAt(provider, 'spec')
      const adapter = objectAt(spec, 'adapter')

      expect(adapter, `${path} must declare spec.adapter`).toBeTruthy()
      expect(objectAt(adapter, 'type'), `${path} must declare spec.adapter.type`).toEqual(expect.any(String))
    }
  })

  it('wires Codex artifact uploads to the Agents-owned Rook bucket claim', () => {
    const kustomization = readYamlObjects('argocd/applications/agents/kustomization.yaml')[0]
    const resources = objectAt(kustomization, 'resources') as string[] | undefined
    expect(resources).toContain('agents-artifacts-objectbucketclaim.yaml')

    const bucketClaim = readYamlObjects('argocd/applications/agents/agents-artifacts-objectbucketclaim.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'ObjectBucketClaim',
    )
    expect(objectAt(objectAt(bucketClaim, 'metadata'), 'name')).toBe('agents-artifacts')
    expect(objectAt(objectAt(bucketClaim, 'spec'), 'bucketName')).toBe('agents-artifacts')
    expect(objectAt(objectAt(bucketClaim, 'spec'), 'storageClassName')).toBe('rook-ceph-bucket')

    const provider = readYamlObjects('argocd/applications/agents/graf-codex-agentprovider.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'AgentProvider',
    )
    const providerSpec = objectAt(provider, 'spec')
    const adapter = objectAt(providerSpec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const secretEnv = objectAt(codex, 'secretEnv') as Record<string, unknown>[] | undefined

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

    const agent = readYamlObjects('argocd/applications/agents/graf-codex-agent.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'Agent',
    )
    const allowedSecrets = objectAt(objectAt(objectAt(agent, 'spec'), 'security'), 'allowedSecrets') as
      | string[]
      | undefined
    expect(allowedSecrets).toEqual(expect.arrayContaining(['codex-auth', 'agents-artifacts']))
    expect(allowedSecrets).not.toContain('observability-minio-creds')
  })

  it('keeps the chart workflow smoke provider on the fake app-server', () => {
    const provider = readYamlObjects('charts/agents/examples/agentprovider-smoke.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'AgentProvider',
    )
    const providerSpec = objectAt(provider, 'spec')
    const adapter = objectAt(providerSpec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const threadConfig = objectAt(codex, 'threadConfig')
    const envTemplate = objectAt(providerSpec, 'envTemplate')

    expect(objectAt(adapter, 'type')).toBe('codex-app-server')
    expect(objectAt(codex, 'binaryPath')).toBe('/usr/local/bin/agents-fake-codex-app-server')
    expect(objectAt(codex, 'model')).toBe('agents-fake-codex-app-server')
    expect(objectAt(codex, 'effort')).toBe('low')
    expect(objectAt(codex, 'cwd')).toBeUndefined()
    expect(objectAt(threadConfig, 'mcp_servers')).toEqual({})
    expect(objectAt(threadConfig, 'web_search')).toBe('off')
    expect(objectAt(envTemplate, 'CODEX_MODEL')).toBe('agents-fake-codex-app-server')
    expect(objectAt(envTemplate, 'CODEX_DISABLE_RESUME')).toBe('1')
    expect(objectAt(envTemplate, 'CODEX_MAX_SESSION_ATTEMPTS')).toBe('1')
  })

  it('runs the live Argo smoke as a deterministic app-server canary without OpenAI quota', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const hooks = objectAt(values, 'argocdHooks')
    const postSync = objectAt(hooks, 'postSync')
    const smoke = objectAt(hooks, 'smoke')
    const smokeRun = objectAt(smoke, 'agentRun') as Record<string, unknown>
    const smokeRunSpec = objectAt(smokeRun, 'spec')
    const provider = readYamlObjects('argocd/applications/agents/codex-spark-smoke-agentprovider.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'AgentProvider',
    )
    const providerSpec = objectAt(provider, 'spec')
    const adapter = objectAt(providerSpec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const envTemplate = objectAt(providerSpec, 'envTemplate')

    expect(objectAt(postSync, 'enabled')).toBe(true)
    expect(objectAt(adapter, 'type')).toBe('codex-app-server')
    expect(objectAt(codex, 'binaryPath')).toBe('/usr/local/bin/agents-fake-codex-app-server')
    expect(objectAt(codex, 'model')).toBe('agents-fake-codex-app-server')
    expect(objectAt(codex, 'effort')).toBe('low')
    expect(objectAt(codex, 'cwd')).toBeUndefined()
    expect(objectAt(envTemplate, 'AGENTS_FAKE_CODEX_APP_SERVER_ARTIFACT')).toBe('/workspace/.agentrun/smoke/result.md')
    expect(JSON.stringify(provider)).not.toContain('gpt-5.5')
    expect(objectAt(smokeRunSpec, 'vcsRef')).toBeUndefined()
    expect(objectAt(smokeRunSpec, 'vcsPolicy')).toBeUndefined()
    expect(objectAt(smokeRunSpec, 'secrets')).toEqual(['codex-auth'])
  })

  it('keeps checked-in workflow AgentRuns runnable with explicit steps', () => {
    const provider = readYamlObjects('argocd/applications/agents/agents-primitives-agentprovider.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'AgentProvider',
    )
    const providerSpec = objectAt(provider, 'spec')
    const adapter = objectAt(providerSpec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const envTemplate = objectAt(providerSpec, 'envTemplate')
    const agentRun = readYamlObjects('argocd/applications/agents/agents-primitives-agentrun.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'AgentRun',
    )
    const spec = objectAt(agentRun, 'spec')
    const workflow = objectAt(spec, 'workflow')
    const steps = objectAt(workflow, 'steps')

    expect(objectAt(objectAt(spec, 'runtime'), 'type')).toBe('workflow')
    expect(Array.isArray(steps)).toBe(true)
    expect(steps).toEqual([
      {
        name: 'implementation',
        timeoutSeconds: 600,
        parameters: { stage: 'implementation' },
      },
    ])
    expect(objectAt(codex, 'binaryPath')).toBe('/usr/local/bin/agents-fake-codex-app-server')
    expect(objectAt(codex, 'model')).toBe('agents-fake-codex-app-server')
    expect(objectAt(codex, 'cwd')).toBeUndefined()
    expect(objectAt(envTemplate, 'AGENTS_FAKE_CODEX_APP_SERVER_ARTIFACT')).toBe('/workspace/lab/.agents-runner.log')
    expect(JSON.stringify(provider)).not.toContain('gpt-5.5')
  })

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

  it('enables Swarm primitive RBAC for the live controllers while keeping domain admission env out of Agents', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const controllers = objectAt(values, 'controllers')
    const env = objectAt(objectAt(controllers, 'env'), 'vars')
    const swarm = objectAt(values, 'swarm')

    expect(objectAt(swarm, 'enabled')).toBe(true)
    expect(objectAt(env, 'AGENTS_MATERIAL_REENTRY_REQUIREMENT_SIGNALS')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SCHEDULE_RUNNER_ADMISSION_STATUS_URL')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE')).toBeUndefined()
    expect(objectAt(env, 'AGENTS_SWARM_REQUIREMENT_MAX_ACTIVE_PER_SWARM')).toBeUndefined()
  })

  it('keeps Facteur Codex dispatch behind the Agents AgentRun API boundary', () => {
    const kustomization = readFileSync(
      resolve(process.cwd(), 'argocd/applications/facteur/overlays/cluster/kustomization.yaml'),
      'utf8',
    )
    const service = readFileSync(
      resolve(process.cwd(), 'argocd/applications/facteur/overlays/cluster/facteur-service.yaml'),
      'utf8',
    )
    const config = readFileSync(
      resolve(process.cwd(), 'argocd/applications/facteur/overlays/cluster/facteur-config.yaml'),
      'utf8',
    )

    expect(kustomization).not.toContain('facteur-workflowtemplate.yaml')
    expect(kustomization).not.toContain('facteur-workflow-serviceaccount.yaml')
    expect(kustomization).not.toContain('facteur-workflows-clusterrolebinding.yaml')
    expect(service).not.toContain('FACTEUR_ARGO_')
    expect(config).not.toContain('workflow_template')
    expect(`${kustomization}\n${service}\n${config}`).not.toContain('agents-codex-runner')
    expect(config).toContain('agents_base_url: http://agents.agents.svc.cluster.local')
  })

  it('renders Codex app-server adapter metadata instead of legacy provider wrapper scripts', () => {
    const manifests = readYamlObjects('argocd/applications/agents/codex-spark-agentprovider.yaml')
    const provider = manifests.find((manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'codex-spark')
    const spec = objectAt(provider, 'spec')
    const adapter = objectAt(spec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const envTemplate = objectAt(objectAt(provider, 'spec'), 'envTemplate')
    const inputFiles = objectAt(objectAt(provider, 'spec'), 'inputFiles') as Record<string, unknown>[] | undefined
    const codexConfig = (inputFiles ?? []).find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/config.toml',
    )

    expect(objectAt(spec, 'binary')).toBe('/usr/local/bin/agent-runner')
    expect(objectAt(spec, 'argsTemplate')).toEqual([])
    expect(objectAt(adapter, 'type')).toBe('codex-app-server')
    expect(objectAt(codex, 'model')).toBe('gpt-5.3-codex-spark')
    expect(objectAt(codex, 'effort')).toBe('xhigh')
    expect(objectAt(codex, 'sandbox')).toBe('danger-full-access')
    expect(objectAt(codex, 'approval')).toBe('never')
    expect(objectAt(codex, 'cwd')).toBe('/workspace/lab')
    expect(objectAt(envTemplate, 'AGENT_RUN_NAME')).toBe('{{agentRun.name}}')
    expect(objectAt(envTemplate, 'AGENT_RUN_NAMESPACE')).toBe('{{agentRun.namespace}}')
    expect(objectAt(envTemplate, 'CODEX_MODEL')).toBe('gpt-5.3-codex-spark')
    expect(objectAt(envTemplate, 'CODEX_MODEL_FALLBACKS')).toBe(
      'gpt-5.5,gpt-5.4,gpt-5.4-mini,gpt-5.2-codex,gpt-5-codex',
    )
    expect(objectAt(envTemplate, 'CODEX_MODEL_FALLBACKS')).not.toContain('gpt-5.3-codex-spark')
    expect(objectAt(envTemplate, 'CODEX_MAX_SESSION_ATTEMPTS')).toBe('5')
    expect(objectAt(codexConfig, 'content')).toContain('model = "gpt-5.3-codex-spark"')
    expect(objectAt(codexConfig, 'content')).not.toContain('model = "gpt-5.5"')
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

describe('autonomous trader provider', () => {
  it('runs the market-open trader on its dedicated paper account', () => {
    const kustomization = readYamlObjects('argocd/applications/synthesis/agents-domain/kustomization.yaml')[0]
    const resources = objectAt(kustomization, 'resources') as string[] | undefined
    const provider = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-agentprovider.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentProvider')
    const schedule = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-schedule.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'Schedule')
    const template = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-agentrun-template.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentRun')
    const greenSchedule = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-green-schedule.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'Schedule')
    const greenTemplate = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-green-agentrun-template.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentRun')
    const agent = readYamlObjects('argocd/applications/synthesis/agents-domain/autonomous-trader-agent.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'Agent',
    )
    const implSpec = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-implspec.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'ImplementationSpec')
    const systemPrompt = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-system-prompt-configmap.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'ConfigMap')
    const envTemplate = objectAt(objectAt(provider, 'spec'), 'envTemplate')
    const secretEnv = objectAt(objectAt(provider, 'spec'), 'secretEnv') as Record<string, unknown>[] | undefined
    const deploymentColorKey = 'autonomous-trader.proompteng.ai/deployment-color'
    const deploymentRoleKey = 'autonomous-trader.proompteng.ai/deployment-role'
    const marketOpenLanes = [
      {
        color: 'blue',
        schedule,
        template,
        templateName: 'autonomous-trader-template',
      },
      {
        color: 'green',
        schedule: greenSchedule,
        template: greenTemplate,
        templateName: 'autonomous-trader-template-green',
      },
    ]
    const activeMarketOpenLanes = marketOpenLanes.filter(
      (lane) => objectAt(objectAt(lane.schedule, 'spec'), 'suspend') === false,
    )
    const previewMarketOpenLanes = marketOpenLanes.filter(
      (lane) => objectAt(objectAt(lane.schedule, 'spec'), 'suspend') === true,
    )
    const overallTimeoutSeconds = Number(objectAt(envTemplate, 'CODEX_MARKET_CONTEXT_OVERALL_TIMEOUT_SECONDS'))
    const systemPromptRef = objectAt(objectAt(objectAt(agent, 'spec'), 'defaults'), 'systemPromptRef')
    const implText = String(objectAt(objectAt(implSpec, 'spec'), 'text') ?? '')
    const systemPromptText = String(objectAt(objectAt(systemPrompt, 'data'), 'system-prompt.md') ?? '')
    const countWords = (value: string) => value.trim().split(/\s+/).filter(Boolean).length

    expect(resources).toContain('autonomous-trader-dedicated-alpaca-mcp-sealedsecret.yaml')
    expect(resources).not.toContain('autonomous-trader-alpaca-mcp-sealedsecret.yaml')
    expect(resources).toContain('autonomous-trader-schedule.yaml')
    expect(resources).toContain('autonomous-trader-agentrun-template.yaml')
    expect(resources).toContain('autonomous-trader-green-schedule.yaml')
    expect(resources).toContain('autonomous-trader-green-agentrun-template.yaml')
    expect(
      existsSync(
        resolve(process.cwd(), 'argocd/applications/synthesis/agents-domain/autonomous-trader-agentrun-template.yaml'),
      ),
    ).toBe(true)
    expect(systemPromptRef).toEqual({
      kind: 'ConfigMap',
      name: 'autonomous-trader-system-prompt',
      key: 'system-prompt.md',
    })
    expect(countWords(implText)).toBeLessThanOrEqual(120)
    expect(countWords(systemPromptText)).toBeLessThanOrEqual(650)
    expect(systemPromptText).toContain('For blocked tickets set `noTradeReason`')
    expect(systemPromptText).toContain('pass returned `ticketId` to risk/order writes')
    expect(activeMarketOpenLanes).toHaveLength(1)
    expect(previewMarketOpenLanes).toHaveLength(1)
    const activeMarketOpenLane = activeMarketOpenLanes[0]
    const activeTemplateSpec = objectAt(activeMarketOpenLane, 'template')
    const activeParameters = objectAt(objectAt(activeTemplateSpec, 'spec'), 'parameters')
    const activeSchedule = objectAt(activeMarketOpenLane, 'schedule')
    const activeAnnotations = objectAt(objectAt(activeSchedule, 'metadata'), 'annotations')
    expect(objectAt(activeAnnotations, 'proompteng.ai/account-isolation-mode')).toBeUndefined()
    expect(objectAt(activeAnnotations, 'proompteng.ai/suspension-reason')).toBeUndefined()
    expect(objectAt(activeParameters, 'mode')).toBe('market-open')
    expect(objectAt(activeParameters, 'synthesisSessionMode')).toBe('market_open')
    expect(objectAt(activeParameters, 'brokerMutationEnabled')).toBe('true')
    expect(objectAt(activeParameters, 'accountType')).toBe('paper')
    expect(objectAt(activeParameters, 'targetEquityUsd')).toBe('500000')
    for (const lane of marketOpenLanes) {
      const scheduleSpec = objectAt(lane.schedule, 'spec')
      const templateSpec = objectAt(lane.template, 'spec')
      const parameters = objectAt(templateSpec, 'parameters')
      const role = objectAt(scheduleSpec, 'suspend') === false ? 'active' : 'preview'
      const scheduleAnnotations = objectAt(objectAt(lane.schedule, 'metadata'), 'annotations')
      const scheduleLabels = objectAt(objectAt(lane.schedule, 'metadata'), 'labels')
      const templateAnnotations = objectAt(objectAt(lane.template, 'metadata'), 'annotations')

      expect(objectAt(scheduleSpec, 'cron')).toBe('15 9 * * 1-5')
      expect(objectAt(scheduleSpec, 'timezone')).toBe('America/New_York')
      expect(objectAt(objectAt(scheduleSpec, 'targetRef'), 'name')).toBe(lane.templateName)
      expect(objectAt(scheduleAnnotations, deploymentColorKey)).toBe(lane.color)
      expect(objectAt(scheduleLabels, deploymentColorKey)).toBe(lane.color)
      expect(objectAt(templateAnnotations, deploymentColorKey)).toBe(lane.color)
      expect(objectAt(scheduleAnnotations, deploymentRoleKey)).toBe(role)
      expect(objectAt(scheduleLabels, deploymentRoleKey)).toBe(role)
      expect(objectAt(templateAnnotations, deploymentRoleKey)).toBe(role)
      expect(objectAt(parameters, 'mode')).toBe('market-open')
      expect(objectAt(parameters, 'synthesisSessionMode')).toBe('market_open')
      expect(objectAt(parameters, 'brokerMutationEnabled')).toBe(role === 'active' ? 'true' : 'false')
      expect(objectAt(parameters, 'accountType')).toBe('paper')
      expect(objectAt(parameters, 'targetEquityUsd')).toBe('500000')
    }
    expect(objectAt(envTemplate, 'AUTONOMOUS_TRADER_MODE')).toBe('{{parameters.mode}}')
    expect(objectAt(envTemplate, 'AUTONOMOUS_TRADER_SYNTHESIS_SESSION_MODE')).toBe(
      '{{parameters.synthesisSessionMode}}',
    )
    expect(objectAt(envTemplate, 'AUTONOMOUS_TRADER_TARGET_EQUITY_USD')).toBe('{{parameters.targetEquityUsd}}')
    expect(objectAt(envTemplate, 'AUTONOMOUS_TRADER_ACCOUNT_TYPE')).toBe('{{parameters.accountType}}')
    expect(objectAt(envTemplate, 'AUTONOMOUS_TRADER_BROKER_MUTATION_ENABLED')).toBe(
      '{{parameters.brokerMutationEnabled}}',
    )
    expect(
      (secretEnv ?? [])
        .filter(
          (entry) =>
            String(objectAt(entry, 'name') ?? '').includes('ALPACA') ||
            String(objectAt(entry, 'name') ?? '').includes('APCA'),
        )
        .map((entry) => objectAt(entry, 'secretName')),
    ).toEqual([
      'autonomous-trader-alpaca-mcp',
      'autonomous-trader-alpaca-mcp',
      'autonomous-trader-alpaca-mcp',
      'autonomous-trader-alpaca-mcp',
      'autonomous-trader-alpaca-mcp',
      'autonomous-trader-alpaca-mcp',
    ])
    expect(overallTimeoutSeconds).toBeGreaterThanOrEqual(32400)
  })

  it('schedules a post-close scorecard readback proof without broker mutations', () => {
    const schedule = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-scorecard-readback-schedule.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'Schedule')
    const template = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-scorecard-readback-template.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentRun')
    const scheduleSpec = objectAt(schedule, 'spec')
    const templateSpec = objectAt(template, 'spec')
    const parameters = objectAt(templateSpec, 'parameters')
    const secrets = objectAt(templateSpec, 'secrets') as unknown[]

    expect(objectAt(scheduleSpec, 'cron')).toBe('20 16 * * 1-5')
    expect(objectAt(scheduleSpec, 'timezone')).toBe('America/New_York')
    expect(objectAt(objectAt(scheduleSpec, 'targetRef'), 'name')).toBe('autonomous-trader-scorecard-readback-template')
    expect(objectAt(parameters, 'mode')).toBe('scorecard-readback')
    expect(objectAt(parameters, 'synthesisSessionMode')).toBe('scorecard_readback')
    expect(objectAt(parameters, 'brokerMutationEnabled')).toBe('false')
    const goal = objectAt(templateSpec, 'goal') as Record<string, unknown>
    expect(Object.hasOwn(goal, 'tokenBudget')).toBe(false)
    expect(secrets).toContain('synthesis-env')
    expect(secrets).toContain('autonomous-trader-alpaca-mcp')
    expect(secrets).not.toContain('alpaca-mcp')
  })

  it('preinstalls day-trading Python dependencies in the Codex runner image', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'services/agents/Dockerfile.codex-runner'), 'utf8')

    expect(dockerfile).toContain('"alpaca-py>=0.43"')
    expect(dockerfile).toContain('"pandas>=2.2"')
    expect(dockerfile).toContain('"pydantic>=2.8"')
    expect(dockerfile).toContain('"pyarrow>=16.0"')
  })

  it('wires the analysis daytrading bootstrap into the trader provider', () => {
    const provider = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-agentprovider.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentProvider')
    const vcsProvider = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-versioncontrolprovider.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'VersionControlProvider')
    const providerSpec = objectAt(provider, 'spec')
    const codex = objectAt(objectAt(providerSpec, 'adapter'), 'codex')
    const envTemplate = objectAt(providerSpec, 'envTemplate')
    const inputFiles = objectAt(providerSpec, 'inputFiles') as Record<string, unknown>[] | undefined
    const outputArtifacts = objectAt(providerSpec, 'outputArtifacts') as Record<string, unknown>[] | undefined
    const inputFilePaths = (inputFiles ?? []).map((inputFile) => objectAt(inputFile, 'path'))
    const artifactNames = (outputArtifacts ?? []).map((artifact) => objectAt(artifact, 'name'))
    const artifactPaths = (outputArtifacts ?? []).map((artifact) => objectAt(artifact, 'path'))
    const artifactKeys = (outputArtifacts ?? []).map((artifact) => objectAt(artifact, 'key')).filter(Boolean)
    const bootstrapScript = (inputFiles ?? []).find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/bootstrap-analysis-daytrading.sh',
    )
    const bootstrapContent = objectAt(bootstrapScript, 'content')

    expect(objectAt(envTemplate, 'ANALYSIS_REPO_URL')).toBe('https://github.com/gregkonush/analysis.git')
    expect(objectAt(envTemplate, 'ANALYSIS_REQUIRED_COMMIT')).toBe('56be940b69bf1a56578040eda9bf2e3699c5220e')
    expect(objectAt(envTemplate, 'ANALYSIS_CONTEXT_PATH')).toBeUndefined()
    expect(objectAt(envTemplate, 'AUTONOMOUS_TRADER_ARTIFACT_DIR')).toBeUndefined()
    expect(objectAt(envTemplate, 'AUTONOMOUS_TRADER_WORK_DIR')).toBe('/tmp/autonomous-trader-work')
    expect(objectAt(envTemplate, 'ANALYSIS_FETCH_DEPTH')).toBeUndefined()
    expect(objectAt(codex, 'model')).toBe('gpt-5.5')
    expect(objectAt(codex, 'effort')).toBe('high')
    expect(inputFilePaths).toContain('/root/.codex/config.toml')
    expect(inputFilePaths).toContain('/root/bootstrap-analysis-daytrading.sh')
    expect(inputFilePaths).not.toContain('/workspace/.agentrun/autonomous-trader/decision-ledger.jsonl')
    expect(inputFilePaths).not.toContain('/workspace/.agentrun/autonomous-trader/protective-orders.jsonl')
    expect(artifactNames).toEqual(['autonomous-trader-report', 'runner-log', 'runner-status'])
    expect(artifactPaths).toEqual([
      '/workspace/.agentrun/autonomous-trader/report.md',
      '/workspace/.agent/runner.log',
      '/workspace/.agent/status.json',
    ])
    expect([...artifactNames, ...artifactPaths, ...artifactKeys].join('\n')).not.toMatch(
      /jsonl|analysis-(bootstrap|context)/,
    )
    expect(bootstrapContent).toContain('report_path="/workspace/.agentrun/autonomous-trader/report.md"')
    expect(bootstrapContent).toContain('work_dir="${AUTONOMOUS_TRADER_WORK_DIR:-/tmp/autonomous-trader-work}"')
    expect(bootstrapContent).toContain('analysis_context_path="${work_dir}/analysis-context.json"')
    expect(bootstrapContent).toContain('analysis_fetch_timeout_seconds="${ANALYSIS_FETCH_TIMEOUT_SECONDS:-180}"')
    expect(bootstrapContent).toContain('fetch --prune --filter=blob:none --depth="${analysis_fetch_depth}"')
    expect(bootstrapContent).toContain('fetch --filter=blob:none --deepen="${analysis_fetch_deepen}"')
    expect(bootstrapContent).toContain(
      'analysis_main_sha="$(git -C "${analysis_dir}" rev-parse refs/remotes/origin/main^{commit})"',
    )
    expect(bootstrapContent).toContain('git -C "${analysis_dir}" checkout --force "${analysis_main_sha}"')
    expect(bootstrapContent).not.toContain('fetch --prune origin main:refs/remotes/origin/main')
    expect(bootstrapContent).not.toContain('checkout --force --detach origin/main')
    expect(bootstrapContent).not.toContain('reset --hard origin/main')
    expect(bootstrapContent).toContain('--output "${analysis_context_path}"')
    expect(bootstrapContent).toContain('analysis_cli="${work_dir}/stock_analysis"')
    expect(bootstrapContent).not.toContain('ANALYSIS_CONTEXT_PATH')
    expect(bootstrapContent).not.toContain('ANALYSIS_BOOTSTRAP_STATUS_PATH')
    expect(bootstrapContent).not.toContain('analysis_bootstrap_status_path')
    expect(bootstrapContent).not.toContain('artifact_dir=')
    expect(bootstrapContent).not.toContain('"${artifact_dir}/analysis-context.json"')
    expect(bootstrapContent).not.toContain('"${artifact_dir}/analysis-bootstrap.json"')
    expect(bootstrapContent).not.toContain('"${artifact_dir}/analysis-venv"')
    expect(objectAt(objectAt(objectAt(vcsProvider, 'spec'), 'repositoryPolicy'), 'allow')).toContain(
      'gregkonush/analysis',
    )
  })

  it('wires Synthesis MCP visibility into the trader provider', () => {
    const provider = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-agentprovider.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentProvider')
    const agent = readYamlObjects('argocd/applications/synthesis/agents-domain/autonomous-trader-agent.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'Agent',
    )
    const template = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-scorecard-readback-template.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentRun')
    const secretBinding = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-secretbinding.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'SecretBinding')
    const spec = objectAt(provider, 'spec')
    const codex = objectAt(objectAt(spec, 'adapter'), 'codex')
    const threadConfig = objectAt(codex, 'threadConfig')
    const synthesis = objectAt(objectAt(threadConfig, 'mcp_servers'), 'synthesis')
    const envTemplate = objectAt(spec, 'envTemplate')
    const secretEnv = objectAt(spec, 'secretEnv') as Record<string, unknown>[] | undefined
    const inputFiles = objectAt(spec, 'inputFiles') as Record<string, unknown>[] | undefined
    const codexConfig = (inputFiles ?? []).find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/config.toml',
    )
    const synthesisProxy = (inputFiles ?? []).find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/synthesis-mcp-proxy.mjs',
    )
    const workload = objectAt(objectAt(template, 'spec'), 'workload')
    const resources = objectAt(workload, 'resources')
    const requests = objectAt(resources, 'requests')
    const limits = objectAt(resources, 'limits')
    const volumes = objectAt(workload, 'volumes') as Record<string, unknown>[] | undefined
    const synthesisVolume = (volumes ?? []).find((volume) => objectAt(volume, 'name') === 'synthesis-env')

    expect(objectAt(synthesis, 'command')).toBe('node')
    expect(objectAt(synthesis, 'args')).toEqual(['/root/.codex/synthesis-mcp-proxy.mjs'])
    expect(objectAt(objectAt(synthesis, 'env'), 'SYNTHESIS_API_TOKEN_FILE')).toBe(
      '/var/run/synthesis/SYNTHESIS_API_TOKEN',
    )
    expect(objectAt(objectAt(synthesis, 'env'), 'SYNTHESIS_MCP_URL')).toBe(
      'http://synthesis.synthesis.svc.cluster.local:3000/mcp',
    )
    expect(objectAt(objectAt(synthesis, 'env'), 'AGENT_RUN_NAME')).toBe('{{ agentRun.name }}')
    expect(objectAt(objectAt(synthesis, 'env'), 'AGENT_RUN_NAMESPACE')).toBe('{{ agentRun.namespace }}')
    expect(objectAt(envTemplate, 'SYNTHESIS_API_TOKEN_FILE')).toBe('/var/run/synthesis/SYNTHESIS_API_TOKEN')
    expect(objectAt(envTemplate, 'SYNTHESIS_MCP_URL')).toBe('http://synthesis.synthesis.svc.cluster.local:3000/mcp')
    expect((secretEnv ?? []).some((entry) => objectAt(entry, 'name') === 'SYNTHESIS_API_TOKEN')).toBe(true)
    expect(objectAt(codexConfig, 'content')).toContain('[mcp_servers.synthesis]')
    expect(objectAt(codexConfig, 'content')).toContain('SYNTHESIS_API_TOKEN_FILE')
    expect(objectAt(codexConfig, 'content')).not.toContain('AGENT_RUN_NAME = "{{ agentRun.name }}"')
    expect(objectAt(codexConfig, 'content')).not.toContain('AGENT_RUN_NAMESPACE = "{{ agentRun.namespace }}"')
    expect(objectAt(synthesisProxy, 'content')).toContain('Synthesis MCP HTTP')
    expect(objectAt(synthesisProxy, 'content')).toContain('Bearer')
    expect(objectAt(synthesisProxy, 'content')).toContain("readJsonFile('/workspace/run.json')")
    expect(objectAt(synthesisProxy, 'content')).toContain('cleanIdentityValue(process.env.AGENT_RUN_NAME)')
    expect(objectAt(synthesisProxy, 'content')).toContain('cleanIdentityValue(runEnvelope?.agentRun?.name)')
    expect(objectAt(synthesisProxy, 'content')).toContain('normalizeAutotraderArguments')
    expect(objectAt(synthesisProxy, 'content')).toContain("toolName !== 'autotrader_start_session'")
    expect(objectAt(synthesisProxy, 'content')).toContain('nextArgs.agentRunName = agentRunName')
    expect(objectAt(requests, 'ephemeral-storage')).toBe('2Gi')
    expect(objectAt(limits, 'ephemeral-storage')).toBe('12Gi')
    expect(objectAt(synthesisVolume, 'mountPath')).toBe('/var/run/synthesis')
    expect(objectAt(synthesisVolume, 'readOnly')).toBe(true)
    expect(objectAt(objectAt(objectAt(agent, 'spec'), 'security'), 'allowedSecrets')).toContain('synthesis-env')
    expect(objectAt(objectAt(secretBinding, 'spec'), 'allowedSecrets')).toContain('synthesis-env')
    expect(objectAt(objectAt(template, 'spec'), 'secrets')).toContain('synthesis-env')
    expect(objectAt(objectAt(objectAt(agent, 'spec'), 'security'), 'allowedSecrets')).toContain(
      'autonomous-trader-alpaca-mcp',
    )
    expect(objectAt(objectAt(objectAt(agent, 'spec'), 'security'), 'allowedSecrets')).not.toContain('alpaca-mcp')
    expect(objectAt(objectAt(secretBinding, 'spec'), 'allowedSecrets')).toContain('autonomous-trader-alpaca-mcp')
    expect(objectAt(objectAt(secretBinding, 'spec'), 'allowedSecrets')).not.toContain('alpaca-mcp')
  })

  it('bridges Codex framed MCP stdio to Alpaca newline stdio', () => {
    const provider = readYamlObjects(
      'argocd/applications/synthesis/agents-domain/autonomous-trader-agentprovider.yaml',
    ).find((manifest) => objectAt(manifest, 'kind') === 'AgentProvider')
    const spec = objectAt(provider, 'spec')
    const codex = objectAt(objectAt(spec, 'adapter'), 'codex')
    const threadConfig = objectAt(codex, 'threadConfig')
    const alpaca = objectAt(objectAt(threadConfig, 'mcp_servers'), 'alpaca')
    const inputFiles = objectAt(spec, 'inputFiles') as Record<string, unknown>[] | undefined
    const codexConfig = (inputFiles ?? []).find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/config.toml',
    )
    const bridge = (inputFiles ?? []).find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/alpaca-mcp-stdio-bridge.py',
    )
    const alpacaBridgeArgs = objectAt(codexConfig, 'content')
      .split('\n')
      .filter((line) => line.trim() === 'args = ["-u", "/root/alpaca-mcp-stdio-bridge.py"]')

    expect(objectAt(alpaca, 'command')).toBe('/usr/bin/python3')
    expect(objectAt(alpaca, 'args')).toEqual(['-u', '/root/alpaca-mcp-stdio-bridge.py'])
    expect(objectAt(alpaca, 'startup_timeout_sec')).toBe(60)
    expect(objectAt(objectAt(alpaca, 'env'), 'ALPACA_API_KEY')).toBe('{{ env.ALPACA_API_KEY }}')
    expect(objectAt(objectAt(alpaca, 'env'), 'ALPACA_SECRET_KEY')).toBe('{{ env.ALPACA_SECRET_KEY }}')
    expect(objectAt(objectAt(alpaca, 'env'), 'ALPACA_PAPER_TRADE')).toBe('{{ env.ALPACA_PAPER_TRADE }}')
    expect(objectAt(objectAt(alpaca, 'env'), 'AUTONOMOUS_TRADER_BROKER_MUTATION_ENABLED')).toBe(
      '{{ env.AUTONOMOUS_TRADER_BROKER_MUTATION_ENABLED }}',
    )
    expect(objectAt(codexConfig, 'content')).toContain('command = "/usr/bin/python3"')
    expect(objectAt(codexConfig, 'content')).toContain('args = ["-u", "/root/alpaca-mcp-stdio-bridge.py"]')
    expect(alpacaBridgeArgs).toHaveLength(1)
    expect(objectAt(codexConfig, 'content')).toContain('startup_timeout_sec = 60.0')
    expect(objectAt(codexConfig, 'content')).toContain(
      'AUTONOMOUS_TRADER_BROKER_MUTATION_ENABLED = "{{ env.AUTONOMOUS_TRADER_BROKER_MUTATION_ENABLED }}"',
    )
    expect(objectAt(bridge, 'content')).toContain('Content-Length:')
    expect(objectAt(bridge, 'content')).toContain('/usr/local/bin/alpaca-mcp-server')
    expect(objectAt(bridge, 'content')).toContain('--transport')
    expect(objectAt(bridge, 'content')).toContain('stdio')
    expect(objectAt(bridge, 'content')).toContain('MUTATION_TOOL_PREFIXES')
    expect(objectAt(bridge, 'content')).toContain('should_block_client_message')
    expect(objectAt(bridge, 'content')).toContain('broker_mutation_gate_disabled')
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
