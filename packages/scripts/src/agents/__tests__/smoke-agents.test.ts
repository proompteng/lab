import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

  it('mounts HF fallback secrets for Codex-backed swarm templates', () => {
    const manifests = readYamlObjects('argocd/applications/agents/swarm-agentrun-templates.yaml')
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

  it('renders Codex HF fallback handoff facts outside the model draft', () => {
    const manifests = readYamlObjects('argocd/applications/agents/codex-spark-agentprovider.yaml')
    const provider = manifests.find((manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'codex-spark')
    const envTemplate = objectAt(objectAt(provider, 'spec'), 'envTemplate')
    const inputFiles = objectAt(objectAt(provider, 'spec'), 'inputFiles') as Record<string, unknown>[] | undefined
    const providerConfig = inputFiles?.find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/provider-codex-spark.json',
    )
    const providerCommand = JSON.parse(String(objectAt(providerConfig, 'content'))).argsTemplate[1]
    const logSanitizer = inputFiles?.find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/sanitize-codex-log.py',
    )
    const fallbackScript = inputFiles?.find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/swarm-hf-codex-fallback.py',
    )
    const sanitizerContent = objectAt(logSanitizer, 'content')
    const content = objectAt(fallbackScript, 'content')

    expect(providerCommand).toContain('2>&1 | python3 /root/.codex/sanitize-codex-log.py | tee "$LOG_PATH"')
    expect(providerCommand).toContain('status=${PIPESTATUS[0]}')
    expect(providerCommand).not.toContain('> >(tee')
    expect(objectAt(envTemplate, 'AGENT_RUN_NAME')).toBe('{{agentRun.name}}')
    expect(objectAt(envTemplate, 'AGENT_RUN_NAMESPACE')).toBe('{{agentRun.namespace}}')
    expect(sanitizerContent).toContain('SUPPRESSED_PROVIDER_HTML = "[suppressed provider HTML response body]"')
    expect(sanitizerContent).toContain('HTML_START_PATTERN = re.compile(')
    expect(content).toContain('def summarize_upstream(upstream: str) -> str:')
    expect(content).toContain('def summarize_failure_tail(log_text: str) -> str:')
    expect(content).toContain('return summarize_failure_tail(log_text)')
    expect(content).toContain('if not line.strip() and (run or stage):')
    expect(content).toContain('if line.startswith("Auto-discovered upstream run:") and not run:')
    expect(content).toContain(
      'def handoff_subject(payload: dict, swarm_name: str, role: str, run_name: str, suffix: str = "") -> str:',
    )
    expect(content).toContain('def render_fallback_result(')
    expect(content).toContain('Auto-discovered upstream run:')
    expect(content).toContain('The wrapper will render authoritative upstream run and stage facts.')
    expect(content).toContain('Primary Codex failure summary:')
    expect(content).toContain('"primary_failure_tail": failure_summary')
    expect(content).toContain('"primary_failure_summary": failure_summary')
    expect(content).toContain('\"upstream_read\": summarize_upstream(upstream)')
    expect(content).toContain(
      'publish_handoff(handoff_subject(payload, swarm_name, role, run_name, "fallback"), handoff)',
    )
    expect(content).not.toContain('Primary Codex failure tail:')
    expect(content).not.toContain('publish_handoff(f"swarm.')
  })

  it('redacts provider HTML before Codex runner logs become swarm evidence', () => {
    const manifests = readYamlObjects('argocd/applications/agents/codex-spark-agentprovider.yaml')
    const provider = manifests.find((manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'codex-spark')
    const inputFiles = objectAt(objectAt(provider, 'spec'), 'inputFiles') as Record<string, unknown>[] | undefined
    const logSanitizer = inputFiles?.find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/sanitize-codex-log.py',
    )
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-log-sanitizer-'))
    const scriptPath = join(tempDir, 'sanitize-codex-log.py')

    writeFileSync(scriptPath, String(objectAt(logSanitizer, 'content')))

    const result = spawnSync('python3', [scriptPath], {
      input: [
        'Running Codex implementation for proompteng/lab#swarm-jangar-control-plane',
        'Failure reason: codex exited with status 1: failed to warm featured plugin ids cache error=remote plugin sync request failed with status 403 Forbidden: <html>',
        '<head><style global>body{font-family:Arial}.challenge-error-text{display:block}</style></head>',
        '<span id="challenge-error-text"',
        'data-cf-error="403">Enable JavaScript and cookies to continue</span>',
        '<body><svg width="41" height="41" viewBox="0 0 41 41"><path d="M37.5324 16.8707"/></svg></body></html>',
        'Turn failed -> Quota exceeded. Check your plan and billing details.',
      ].join('\n'),
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('failed to warm featured plugin ids cache')
    expect(result.stdout).toContain('[suppressed provider HTML response body]')
    expect(result.stdout).toContain('Quota exceeded')
    expect(result.stdout).not.toContain('<html')
    expect(result.stdout).not.toContain('<style')
    expect(result.stdout).not.toContain('<span')
    expect(result.stdout).not.toContain('viewBox')
    expect(result.stdout).not.toContain('challenge-error-text')
    expect(result.stdout).not.toMatch(/<[A-Za-z]/)
  })

  it('classifies current Codex quota logs as HF fallback eligible', () => {
    const manifests = readYamlObjects('argocd/applications/agents/codex-spark-agentprovider.yaml')
    const provider = manifests.find((manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'codex-spark')
    const inputFiles = objectAt(objectAt(provider, 'spec'), 'inputFiles') as Record<string, unknown>[] | undefined
    const fallbackPredicate = inputFiles?.find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/should-hf-swarm-fallback.py',
    )
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-fallback-'))
    const scriptPath = join(tempDir, 'should-hf-swarm-fallback.py')
    const logPath = join(tempDir, 'runner.log')

    writeFileSync(scriptPath, String(objectAt(fallbackPredicate, 'content')))
    writeFileSync(
      logPath,
      [
        'Running Codex implementation for proompteng/lab#swarm-jangar-control-plane',
        'Turn started',
        'Stream error -> Quota exceeded. Check your plan and billing details.',
        'Turn failed -> Quota exceeded. Check your plan and billing details.',
      ].join('\n'),
    )

    const result = spawnSync('python3', [scriptPath, logPath], { encoding: 'utf8' })

    expect(result.status).toBe(0)
  })

  it('renders HF team handoff quality evidence outside the model draft', () => {
    const manifests = readYamlObjects('argocd/applications/agents/hf-team-agentprovider.yaml')
    const provider = manifests.find((manifest) => objectAt(objectAt(manifest, 'metadata'), 'name') === 'hf-team-worker')
    const envTemplate = objectAt(objectAt(provider, 'spec'), 'envTemplate')
    const inputFiles = objectAt(objectAt(provider, 'spec'), 'inputFiles') as Record<string, unknown>[] | undefined
    const workerScript = inputFiles?.find(
      (inputFile) => objectAt(inputFile, 'path') === '/root/.codex/hf-team-worker.py',
    )
    const content = objectAt(workerScript, 'content')

    expect(objectAt(envTemplate, 'AGENT_RUN_NAME')).toBe('{{agentRun.name}}')
    expect(objectAt(envTemplate, 'AGENT_RUN_NAMESPACE')).toBe('{{agentRun.namespace}}')
    expect(content).toContain('def summarize_upstream(upstream: str) -> dict:')
    expect(content).toContain('def handoff_subject(payload: dict, swarm_name: str, role: str, run_name: str) -> str:')
    expect(content).toContain(
      'def quality_report(stage: str, upstream_info: dict, exact_next_action: str, issues: list[str]) -> dict:',
    )
    expect(content).toContain('def render_handoff(')
    expect(content).toContain(
      'The wrapper will render authoritative role, objective, upstream, evidence, issue, next-action, and value-gate fields.',
    )
    expect(content).toContain('\"handoff_quality\": quality')
    expect(content).toContain('\"exact_next_action\": exact_next_action')
    expect(content).toContain('subject = handoff_subject(payload, swarm_name, role, run_name)')
    expect(content).toContain('publish_handoff(subject, handoff)')
    expect(content).toContain('\"subject\": subject')
    expect(content).not.toContain('publish_handoff(f"swarm.')
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
