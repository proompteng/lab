import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

import { localSmokeRunnerImage } from '../resolve-smoke-runner-image'
import {
  checkFreshDeploymentReady,
  isFreshDeploymentReady,
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

const skipCrossProductBoundaryTests = process.env.AGENTS_CI_SKIP_CROSS_PRODUCT_BOUNDARIES === 'true'
const crossProductIt = skipCrossProductBoundaryTests ? it.skip : it

const readyDeployment = () => ({
  metadata: { generation: 3 },
  spec: { replicas: 1 },
  status: {
    observedGeneration: 3,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
    unavailableReplicas: 0,
    conditions: [
      { type: 'Available', status: 'True' },
      { type: 'Progressing', status: 'True' },
    ],
  },
})

describe('fresh deployment readiness after a failed watch', () => {
  it('accepts current fully available state from one bounded fresh read', async () => {
    const commands: string[][] = []
    const ready = await checkFreshDeploymentReady('agents-ci', 'agents-ci-postgres', async (command) => {
      commands.push(command)
      return { exitCode: 0, timedOut: false, stderr: '', stdout: JSON.stringify(readyDeployment()) }
    })
    expect(ready).toBe(true)
    expect(commands).toEqual([
      ['kubectl', '--request-timeout=5s', '-n', 'agents-ci', 'get', 'deployment', 'agents-ci-postgres', '-o', 'json'],
    ])
  })

  it('rejects a stale observed generation even with ready replica counts', () => {
    const snapshot = readyDeployment()
    snapshot.status.observedGeneration = 2
    expect(isFreshDeploymentReady(snapshot)).toBe(false)
  })

  it('rejects a scaled-to-zero dependency even when all zero counts are available', () => {
    const snapshot = readyDeployment()
    snapshot.spec.replicas = 0
    snapshot.status.replicas = 0
    snapshot.status.updatedReplicas = 0
    snapshot.status.readyReplicas = 0
    snapshot.status.availableReplicas = 0
    expect(isFreshDeploymentReady(snapshot)).toBe(false)
  })

  it.each(['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas'] as const)(
    'rejects incomplete %s',
    (field) => {
      const snapshot = readyDeployment()
      snapshot.status[field] = 0
      expect(isFreshDeploymentReady(snapshot)).toBe(false)
    },
  )

  it('rejects unavailable replicas, old replicas, and a current failed rollout', () => {
    const snapshot = readyDeployment()
    snapshot.status.unavailableReplicas = 1
    expect(isFreshDeploymentReady(snapshot)).toBe(false)
    snapshot.status.unavailableReplicas = 0
    snapshot.status.replicas = 2
    expect(isFreshDeploymentReady(snapshot)).toBe(false)
    snapshot.status.replicas = 1
    snapshot.status.conditions[1] = { type: 'Progressing', status: 'False' }
    expect(isFreshDeploymentReady(snapshot)).toBe(false)
  })

  it('fails closed for deleting, missing, or malformed deployment state', () => {
    expect(
      isFreshDeploymentReady({ ...readyDeployment(), metadata: { generation: 3, deletionTimestamp: 'now' } }),
    ).toBe(false)
    expect(isFreshDeploymentReady({})).toBe(false)
    expect(isFreshDeploymentReady({ ...readyDeployment(), spec: { replicas: '1' } })).toBe(false)
    expect(isFreshDeploymentReady(null)).toBe(false)
  })

  it('preserves failure on timeout, unreachable API, or invalid JSON', async () => {
    for (const response of [
      { exitCode: 1, timedOut: false, stderr: 'unreachable', stdout: '' },
      { exitCode: 0, timedOut: true, stderr: '', stdout: JSON.stringify(readyDeployment()) },
      { exitCode: 0, timedOut: false, stderr: '', stdout: 'not-json' },
    ]) {
      expect(await checkFreshDeploymentReady('agents-ci', 'fixture', async () => response)).toBe(false)
    }
    expect(
      await checkFreshDeploymentReady('agents-ci', 'fixture', async () => {
        throw new Error('unavailable')
      }),
    ).toBe(false)
  })
})

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
      '--set-string',
      `env.vars.AGENTS_AGENT_RUNNER_IMAGE=${localSmokeRunnerImage}`,
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

  it('passes the exact published smoke runner digest to AgentRun jobs independently of deployment images', () => {
    const valuesFile = resolve(process.cwd(), 'scripts/agents/values-ci.yaml')
    const smokeRunnerImage = `registry.ide-newton.ts.net/lab/agents-smoke-runner:sha-${'a'.repeat(40)}@sha256:${'b'.repeat(64)}`
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile,
      createNamespace: false,
      imageRepository: 'registry.example/agents-control-plane',
      controlPlaneImageRepository: 'registry.example/agents-control-plane',
      controllersImageRepository: 'registry.example/agents-controller',
      imageTag: 'ci',
      imageDigestSet: true,
      imageDigest: `sha256:${'c'.repeat(64)}`,
      smokeRunnerImage,
    })

    expect(args.slice(-2)).toEqual(['--set-string', `env.vars.AGENTS_AGENT_RUNNER_IMAGE=${smokeRunnerImage}`])
  })

  it.each([
    '',
    'registry.ide-newton.ts.net/lab/agents-codex-runner:nix',
    'registry.ide-newton.ts.net/lab/agents-smoke-runner:latest',
    `registry.ide-newton.ts.net/lab/agents-smoke-runner:sha-${'a'.repeat(40)}`,
  ])('does not accept a missing, production, or unpinned published runner (%s)', (smokeRunnerImage) => {
    expect(() =>
      buildHelmArgs({
        releaseName: 'agents',
        namespace: 'agents-ci',
        valuesFile: resolve(process.cwd(), 'scripts/agents/values-ci.yaml'),
        createNamespace: false,
        imageDigestSet: false,
        imageDigest: '',
        smokeRunnerImage,
      }),
    ).toThrow('AGENTS_SMOKE_RUNNER_IMAGE')
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
      controlPlaneImageTag: '80403146',
      controllersImageTag: '80403146',
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
      'argocd/applications/agents/codex-smoke-agentprovider.yaml',
      'argocd/applications/agents/anypi-agentprovider.yaml',
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

    const provider = readYamlObjects('argocd/applications/agents/codex-agentprovider.yaml')[0]
    const env = objectAt(objectAt(provider, 'spec'), 'envTemplate')
    expect(objectAt(env, 'AGENTS_ARTIFACTS_BUCKET')).toBe('agents-artifacts')
    expect(objectAt(env, 'AGENTS_ARTIFACTS_ENDPOINT')).toBe('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80')
  })

  it('gives the headless Codex provider a 60-second bootstrap budget and only the Auto Ontology MCP bridge', () => {
    const provider = readYamlObjects('argocd/applications/agents/codex-agentprovider.yaml')[0]
    const spec = objectAt(provider, 'spec')
    const codex = objectAt(objectAt(spec, 'adapter'), 'codex')
    const inputFiles = objectAt(spec, 'inputFiles') as unknown[]
    const input = inputFiles.find((file) => objectAt(file, 'path') === '/root/.codex/config.toml')
    const config = Bun.TOML.parse(String(objectAt(input, 'content')))

    expect(objectAt(codex, 'bootstrapTimeoutMs')).toBe(60_000)
    expect(objectAt(objectAt(spec, 'workload'), 'serviceAccountName')).toBe('codex-auto-ontology-runner')
    expect(objectAt(objectAt(codex, 'threadConfig'), 'mcp_servers')).toEqual({
      auto_ontology: {
        command: '/usr/local/bin/auto-ontology-mcp-bridge',
        required: false,
        startup_timeout_sec: 15,
        tool_timeout_sec: 100,
        env_vars: ['AGENTS_MCP_IDENTITY_TOKEN_PATH'],
        env: {
          AUTO_ONTOLOGY_MCP_GATEWAY_URL: 'http://agents-auto-ontology-mcp-gateway.agents.svc.cluster.local:8080/mcp',
        },
      },
    })
    expect(objectAt(config, 'mcp_servers')).toEqual({})
    expect(objectAt(objectAt(config, 'features'), 'multi_agent')).toBeUndefined()

    const orchestrations = readYamlObjects('argocd/applications/agents/codex-orchestrations.yaml')
    for (const orchestration of orchestrations) {
      const steps = objectAt(orchestration, 'spec').steps as unknown[]
      const runtime = JSON.parse(String(objectAt(objectAt(steps[0], 'with'), 'runtime')))
      expect(runtime.config.serviceAccountName).toBe('codex-auto-ontology-runner')
    }
  })

  it('ends the default Codex worker task at a locally validated, ready-to-review PR', () => {
    const configMap = readYamlObjects('argocd/applications/agents/codex-agent-system-prompt-configmap.yaml')[0]
    const prompt = objectAt(objectAt(configMap, 'data'), 'system-prompt.md')

    expect(prompt).toContain('Validate locally')
    expect(prompt).toContain('open a ready-to-review PR')
    expect(prompt).toMatch(/Once the PR is open, .*exit\./)
    expect(prompt).toMatch(/Do not wait for CI or review[\s\S]+or merge unless the task prompt explicitly asks/)
    expect(prompt).not.toContain('ready-to-merge PR')
  })

  it('keeps the chart workflow smoke provider on the fake app-server', () => {
    const provider = readYamlObjects('charts/agents/examples/agentprovider-smoke.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'AgentProvider',
    )
    const providerSpec = objectAt(provider, 'spec')
    const adapter = objectAt(providerSpec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const threadConfig = objectAt(codex, 'threadConfig')

    expect(objectAt(adapter, 'type')).toBe('codex-app-server')
    expect(objectAt(codex, 'binaryPath')).toBe('/usr/local/bin/agents-fake-codex-app-server')
    expect(objectAt(codex, 'model')).toBe('agents-fake-codex-app-server')
    expect(objectAt(codex, 'effort')).toBe('low')
    expect(objectAt(codex, 'cwd')).toBeUndefined()
    expect(objectAt(threadConfig, 'mcp_servers')).toEqual({})
    expect(objectAt(threadConfig, 'web_search')).toBe('off')
  })

  it('runs the live Argo smoke as a deterministic app-server canary without OpenAI quota', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const hooks = objectAt(values, 'argocdHooks')
    const postSync = objectAt(hooks, 'postSync')
    const smoke = objectAt(hooks, 'smoke')
    const smokeRun = objectAt(smoke, 'agentRun') as Record<string, unknown>
    const additionalSmokeRuns = objectAt(smoke, 'additionalAgentRuns')
    const smokeRunSpec = objectAt(smokeRun, 'spec')
    const provider = readYamlObjects('argocd/applications/agents/codex-smoke-agentprovider.yaml').find(
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
    expect(JSON.stringify(provider)).not.toContain('gpt-5.6-sol')
    expect(objectAt(smokeRunSpec, 'vcsRef')).toBeUndefined()
    expect(objectAt(smokeRunSpec, 'vcsPolicy')).toBeUndefined()
    expect(objectAt(smokeRunSpec, 'secrets')).toEqual(['codex-auth'])
    expect(Array.isArray(additionalSmokeRuns)).toBe(true)
    expect(
      (additionalSmokeRuns as Record<string, unknown>[]).map((run) => objectAt(objectAt(run, 'metadata'), 'name')),
    ).toContain('agents-primitives-agentrun')
  })

  it('preserves the agents-shell full-depth workspace bootstrap value', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const agentsShell = objectAt(values, 'agentsShell')
    const workspace = objectAt(agentsShell, 'workspace')
    const bootstrap = objectAt(workspace, 'bootstrap')
    const deploymentTemplate = readFileSync(
      resolve(process.cwd(), 'charts/agents/templates/agents-shell-deployment.yaml'),
      'utf8',
    )

    expect(objectAt(bootstrap, 'enabled')).toBe(true)
    expect(objectAt(bootstrap, 'depth')).toBe(0)
    expect(deploymentTemplate).toContain('hasKey $workspaceBootstrap "depth"')
    expect(deploymentTemplate).toContain('value: {{ $workspaceBootstrap.depth | quote }}')
    expect(deploymentTemplate).not.toContain('default 1 $workspaceBootstrap.depth')
    expect(deploymentTemplate).toContain('git -C "${GIT_TARGET_PATH}" fetch --unshallow origin "${GIT_BRANCH}"')
    expect(deploymentTemplate).toContain('timeout 60s git -C "${GIT_TARGET_PATH}" diff --quiet')
    expect(deploymentTemplate).toContain('/workspace/.agents-shell/checkouts')
    expect(deploymentTemplate).toContain('preserve_checkout "local changes or git dirty-check timeout"')
    expect(deploymentTemplate).toContain('preserve_checkout "target exists and is not an empty git checkout"')
  })

  it('runs the primitives workflow smoke through the polling Argo hook', () => {
    const agent = readYamlObjects('argocd/applications/agents/agents-primitives-agent.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'Agent',
    )
    const provider = readYamlObjects('argocd/applications/agents/agents-primitives-agentprovider.yaml').find(
      (manifest) => objectAt(manifest, 'kind') === 'AgentProvider',
    )
    const agentSpec = objectAt(agent, 'spec')
    const defaults = objectAt(agentSpec, 'defaults')
    const providerSpec = objectAt(provider, 'spec')
    const adapter = objectAt(providerSpec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const envTemplate = objectAt(providerSpec, 'envTemplate')
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const hooks = objectAt(values, 'argocdHooks')
    const smoke = objectAt(hooks, 'smoke')
    const additionalAgentRuns = objectAt(smoke, 'additionalAgentRuns')
    expect(Array.isArray(additionalAgentRuns)).toBe(true)
    const agentRun = (additionalAgentRuns as Record<string, unknown>[]).find(
      (manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'agents-primitives-agentrun',
    )
    const spec = objectAt(agentRun, 'spec')
    const workflow = objectAt(spec, 'workflow')
    const steps = objectAt(workflow, 'steps')
    const hookTemplate = readFileSync(resolve(process.cwd(), 'charts/agents/templates/argocd-hooks.yaml'), 'utf8')
    const kustomization = readYamlObjects('argocd/applications/agents/kustomization.yaml')[0]
    const resources = objectAt(kustomization, 'resources')

    expect(objectAt(defaults, 'systemPrompt')).toContain('deterministic Agents primitives smoke-test agent')
    expect(objectAt(spec, 'ttlSecondsAfterFinished')).toBe(600)
    expect(objectAt(objectAt(spec, 'runtime'), 'type')).toBe('workflow')
    expect(objectAt(objectAt(spec, 'runtime'), 'config')).toBeUndefined()
    expect(Array.isArray(steps)).toBe(true)
    expect(steps).toEqual([
      {
        name: 'implementation',
        timeoutSeconds: 600,
        parameters: { stage: 'implementation' },
      },
    ])
    expect(hookTemplate).toContain('argocd.argoproj.io/hook: PostSync')
    expect(hookTemplate).toContain('range $agentRun := $agentRuns')
    expect(hookTemplate).toContain('Failed|Cancelled')
    expect(hookTemplate).toContain('Succeeded)')
    expect(resources).not.toContain('agents-primitives-agentrun.yaml')
    expect(existsSync(resolve(process.cwd(), 'argocd/applications/agents/agents-primitives-agentrun.yaml'))).toBe(false)
    expect(objectAt(codex, 'binaryPath')).toBe('/usr/local/bin/agents-fake-codex-app-server')
    expect(objectAt(codex, 'model')).toBe('agents-fake-codex-app-server')
    expect(objectAt(codex, 'cwd')).toBeUndefined()
    expect(objectAt(envTemplate, 'AGENTS_FAKE_CODEX_APP_SERVER_ARTIFACT')).toBe('/workspace/lab/.agents-runner.log')
    expect(JSON.stringify(provider)).not.toContain('gpt-5.6-sol')
  })

  it('sizes default AgentRun jobs and spreads them away from the Ryzen node', () => {
    const values = readYamlObjects('argocd/applications/agents/values.yaml')[0]
    const controller = objectAt(values, 'controller')
    const defaultWorkload = objectAt(controller, 'defaultWorkload')
    const resources = objectAt(defaultWorkload, 'resources')
    const requests = objectAt(resources, 'requests')
    const limits = objectAt(resources, 'limits')

    expect(objectAt(requests, 'cpu')).toBe('500m')
    expect(objectAt(requests, 'memory')).toBe('4Gi')
    expect(objectAt(requests, 'ephemeral-storage')).toBe('8Gi')
    expect(objectAt(limits, 'memory')).toBe('32Gi')
    expect(objectAt(limits, 'ephemeral-storage')).toBe('16Gi')
    expect(objectAt(defaultWorkload, 'affinity')).toEqual({
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'NotIn', values: ['talos-192-168-1-194'] }],
            },
          ],
        },
      },
    })
    expect(objectAt(defaultWorkload, 'topologySpreadConstraints')).toEqual([
      {
        maxSkew: 4,
        topologyKey: 'kubernetes.io/hostname',
        whenUnsatisfiable: 'ScheduleAnyway',
        labelSelector: { matchExpressions: [{ key: 'agents.proompteng.ai/agent-run', operator: 'Exists' }] },
      },
    ])
    const concurrency = objectAt(controller, 'concurrency')
    expect(objectAt(concurrency, 'perAgent')).toBe(96)
    expect(objectAt(concurrency, 'perNamespace')).toBe(112)
    expect(objectAt(concurrency, 'cluster')).toBe(160)
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

  crossProductIt('keeps Facteur Codex dispatch behind the Agents AgentRun API boundary', () => {
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
    const manifests = readYamlObjects('argocd/applications/agents/codex-agentprovider.yaml')
    const provider = manifests.find((manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'codex')
    const spec = objectAt(provider, 'spec')
    const adapter = objectAt(spec, 'adapter')
    const codex = objectAt(adapter, 'codex')
    const inputFiles = objectAt(objectAt(provider, 'spec'), 'inputFiles') as Record<string, unknown>[] | undefined
    const codexConfig = (inputFiles ?? []).find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/config.toml',
    )

    expect(objectAt(spec, 'binary')).toBe('/usr/local/bin/agent-runner')
    expect(objectAt(spec, 'argsTemplate')).toEqual([])
    expect(objectAt(adapter, 'type')).toBe('codex-app-server')
    expect(objectAt(codex, 'model')).toBe('gpt-6.2-sol')
    expect(objectAt(codex, 'effort')).toBe('max')
    expect(objectAt(codex, 'sandbox')).toBe('danger-full-access')
    expect(objectAt(codex, 'approval')).toBe('never')
    expect(objectAt(codex, 'cwd')).toBe('/workspace/lab')
    expect(objectAt(codexConfig, 'content')).toContain('model = "gpt-6.2-sol"')
    expect(objectAt(codexConfig, 'content')).toContain('model_reasoning_effort = "max"')
    expect(objectAt(codexConfig, 'content')).not.toContain('model_reasoning_effort = "high"')
    expect(objectAt(codexConfig, 'content')).not.toContain('model = "gpt-5.6-sol"')
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
