#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const runInherit = async (cmd: string[], env?: Record<string, string | undefined>) => {
  console.log(`$ ${cmd.join(' ')}`.trim())
  const subprocess = Bun.spawn(cmd, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: buildEnv(env),
  })
  return subprocess.exited
}

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const parseDurationMs = (value: string | undefined, fallbackMs: number): number => {
  if (!value) return fallbackMs
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  if (!match) return fallbackMs
  const amount = Number.parseFloat(match[1] ?? '')
  if (!Number.isFinite(amount) || amount <= 0) return fallbackMs
  const unit = match[2] ?? 's'
  switch (unit) {
    case 'ms':
      return amount
    case 'm':
      return amount * 60 * 1000
    case 'h':
      return amount * 60 * 60 * 1000
    default:
      return amount * 1000
  }
}

const log = (message: string) => {
  const time = new Date()
  const stamp = time.toTimeString().slice(0, 8)
  console.log(`[${stamp}] ${message}`)
}

const execCapture = async (cmd: string[], env?: Record<string, string | undefined>) => {
  const subprocess = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildEnv(env),
  })

  void subprocess.stdin?.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
}

const buildEnv = (env?: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(env ? { ...process.env, ...env } : process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>

const transientKubectlErrorPatterns = [
  /couldn't get current server API group list/i,
  /connection reset by peer/i,
  /error from a previous attempt/i,
  /\beof\b/i,
  /context deadline exceeded/i,
  /context canceled/i,
  /i\/o timeout/i,
  /tls handshake timeout/i,
  /connection refused/i,
  /unable to connect to the server/i,
  /no route to host/i,
  /server is currently unable to handle the request/i,
  /service unavailable/i,
  /Error from server \(Forbidden\): unknown/i,
] as const

const formatCommandResult = ({ stdout, stderr }: Pick<Awaited<ReturnType<typeof execCapture>>, 'stdout' | 'stderr'>) =>
  [stderr, stdout].filter(Boolean).join('\n').trim()

export const isTransientKubectlError = (message: string) =>
  transientKubectlErrorPatterns.some((pattern) => pattern.test(message))

export const isPermissionDeniedKubectlError = (message: string) =>
  /forbidden|cannot/i.test(message) && !isTransientKubectlError(message)

type BuildHelmArgsInput = {
  releaseName: string
  namespace: string
  valuesFile: string
  createNamespace: boolean
  databaseUrl?: string
  imageRepository?: string
  imageTag?: string
  imageDigestSet: boolean
  imageDigest: string
}

export const buildHelmArgs = ({
  releaseName,
  namespace,
  valuesFile,
  createNamespace,
  databaseUrl,
  imageRepository,
  imageTag,
  imageDigestSet,
  imageDigest,
}: BuildHelmArgsInput) => {
  const helmArgs = [
    'upgrade',
    '--install',
    releaseName,
    resolve(repoRoot, 'charts/agents'),
    '--namespace',
    namespace,
    '--values',
    valuesFile,
  ]

  if (createNamespace) {
    helmArgs.push('--create-namespace')
  }

  if (databaseUrl) {
    helmArgs.push('--set-string', `database.url=${databaseUrl}`)
  }
  if (imageRepository) {
    helmArgs.push('--set', `image.repository=${imageRepository}`)
  }
  if (imageTag) {
    helmArgs.push('--set', `image.tag=${imageTag}`)
  }
  if (imageDigestSet) {
    helmArgs.push('--set', `image.digest=${imageDigest}`)
  }

  return helmArgs
}

type BuildKubectlApplyArgsInput = {
  namespace: string
  file?: string
}

export const buildKubectlApplyArgs = ({ namespace, file }: BuildKubectlApplyArgsInput) => {
  // Smoke manifests are generated at runtime; skip OpenAPI validation so fresh kind API servers
  // do not fail the test on transient schema fetch EOFs.
  const kubectlArgs = ['-n', namespace, 'apply', '--validate=false', '-f']
  kubectlArgs.push(file ?? '-')
  return kubectlArgs
}

const agentsCrdsPath = resolve(repoRoot, 'charts/agents/crds')

export const buildKubectlApplyCrdsArgs = () => ['apply', '-f', agentsCrdsPath]

export const buildKubectlWaitForCrdsArgs = (timeout = '120s') => [
  'wait',
  '--for=condition=Established',
  `--timeout=${timeout}`,
  '-f',
  agentsCrdsPath,
]

const waitForKubectlApi = async (timeoutMs: number) => {
  const start = Date.now()
  let lastError = ''

  while (Date.now() - start < timeoutMs) {
    const result = await execCapture(['kubectl', 'version', '--request-timeout=5s'])
    if (result.exitCode === 0) return

    lastError = formatCommandResult(result)
    if (!isTransientKubectlError(lastError)) {
      fatal('Kubernetes API did not become ready.', lastError)
    }

    await sleep(2000)
  }

  fatal('Timed out waiting for Kubernetes API readiness.', lastError)
}

const ensureNamespace = async (namespace: string, createNamespace: boolean) => {
  const deadline = Date.now() + 60_000
  let lastError = ''

  while (Date.now() < deadline) {
    const namespaceCheck = await execCapture(['kubectl', 'get', 'namespace', namespace])
    if (namespaceCheck.exitCode === 0) {
      return
    }

    const namespaceError = formatCommandResult(namespaceCheck)
    lastError = namespaceError

    if (isTransientKubectlError(namespaceError)) {
      await sleep(2000)
      continue
    }

    if (isPermissionDeniedKubectlError(namespaceError)) {
      if (createNamespace) {
        fatal(`Insufficient permissions to verify or create namespace ${namespace}.`, namespaceError)
      }
      log(`Skipping namespace existence check for ${namespace} due to RBAC.`)
      return
    }

    if (!createNamespace) {
      fatal(`Namespace ${namespace} does not exist and AGENTS_CREATE_NAMESPACE=false.`, namespaceError)
    }

    const createResult = await execCapture(['kubectl', 'create', 'namespace', namespace])
    if (createResult.exitCode === 0) {
      return
    }

    const createError = formatCommandResult(createResult)
    lastError = createError

    if (isTransientKubectlError(createError)) {
      await sleep(2000)
      continue
    }

    if (/already exists/i.test(createError)) {
      return
    }

    fatal(`Failed to create namespace ${namespace}.`, createError)
  }

  fatal(`Timed out ensuring namespace ${namespace}.`, lastError)
}

const listPodNames = async (namespace: string) => {
  const result = await execCapture([
    'kubectl',
    '-n',
    namespace,
    'get',
    'pods',
    '-o',
    'jsonpath={.items[*].metadata.name}',
  ])
  if (result.exitCode !== 0) return []
  return result.stdout.split(/\s+/).filter(Boolean)
}

const dumpNamespaceDiagnostics = async (namespace: string, releaseName: string) => {
  console.error(
    `\n[diagnostics] Dumping agents smoke test diagnostics for namespace=${namespace} release=${releaseName}`,
  )

  await runInherit(['kubectl', '-n', namespace, 'get', 'deploy,rs,pods,svc', '-o', 'wide'])
  await runInherit(['kubectl', '-n', namespace, 'describe', 'deployment', releaseName])

  const pods = await listPodNames(namespace)
  for (const pod of pods) {
    await runInherit(['kubectl', '-n', namespace, 'describe', 'pod', pod])
    await runInherit(['kubectl', '-n', namespace, 'logs', pod, '--all-containers=true', '--tail=200'])
  }

  await runInherit(['kubectl', '-n', namespace, 'get', 'events', '--sort-by=.metadata.creationTimestamp'])
}

const applyYaml = async (namespace: string, manifest: string) => {
  const subprocess = Bun.spawn(['kubectl', ...buildKubectlApplyArgs({ namespace })], {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  void subprocess.stdin?.write(manifest)
  void subprocess.stdin?.end()

  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    fatal(`kubectl apply failed (${exitCode})`)
  }
}

const waitForAgentRun = async (namespace: string, name: string, timeoutMs: number) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await execCapture(['kubectl', '-n', namespace, 'get', 'agentrun', name])
    if (result.exitCode === 0) return
    await sleep(1000)
  }
  fatal(`Timed out waiting for AgentRun ${name} to appear.`)
}

const waitForPhase = async (namespace: string, name: string, expected: string, timeoutMs: number) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await execCapture([
      'kubectl',
      '-n',
      namespace,
      'get',
      'agentrun',
      name,
      '-o',
      'jsonpath={.status.phase}',
    ])
    if (result.exitCode !== 0) {
      await sleep(1000)
      continue
    }

    const phase = result.stdout
    if (phase === expected) return
    if (phase === 'Failed') {
      await run('kubectl', ['-n', namespace, 'get', 'agentrun', name, '-o', 'yaml'])
      fatal(`AgentRun failed while waiting for phase ${expected}.`)
    }
    if (phase === 'Succeeded' && (expected === 'Pending' || expected === 'Running')) return
    await sleep(1000)
  }

  await run('kubectl', ['-n', namespace, 'get', 'agentrun', name, '-o', 'yaml'])
  fatal(`Timed out waiting for AgentRun ${name} phase=${expected}.`)
}

const waitForJobs = async (namespace: string, name: string, expected: number, timeoutMs: number) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await execCapture([
      'kubectl',
      '-n',
      namespace,
      'get',
      'job',
      '-l',
      `agents.proompteng.ai/agent-run=${name}`,
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ])
    const count = result.exitCode === 0 ? result.stdout.split(/\s+/).filter(Boolean).length : 0
    if (count >= expected) return

    const phaseResult = await execCapture([
      'kubectl',
      '-n',
      namespace,
      'get',
      'agentrun',
      name,
      '-o',
      'jsonpath={.status.phase}',
    ])
    const phase = phaseResult.exitCode === 0 ? phaseResult.stdout.trim() : ''
    if (phase === 'Failed') {
      await run('kubectl', ['-n', namespace, 'get', 'agentrun', name, '-o', 'yaml'])
      fatal(`AgentRun ${name} failed before creating ${expected} job(s).`)
    }

    await sleep(1000)
  }

  await run('kubectl', ['-n', namespace, 'get', 'job', '-l', `agents.proompteng.ai/agent-run=${name}`, '-o', 'yaml'])
  fatal(`Timed out waiting for ${expected} job(s).`)
}

const getWorkflowSteps = async (namespace: string, name: string): Promise<number> => {
  const result = await execCapture([
    'kubectl',
    '-n',
    namespace,
    'get',
    'agentrun',
    name,
    '-o',
    'jsonpath={.spec.workflow.steps[*].name}',
  ])
  if (result.exitCode !== 0 || !result.stdout) return 0
  return result.stdout.split(/\s+/).filter(Boolean).length
}

const main = async () => {
  ensureCli('kubectl')
  ensureCli('helm')

  const namespace = process.env.AGENTS_NAMESPACE ?? 'agents'
  const releaseName = process.env.AGENTS_RELEASE_NAME ?? 'agents'
  const valuesFile = resolve(repoRoot, process.env.AGENTS_VALUES_FILE ?? 'charts/agents/values-local.yaml')
  const agentRunFile = resolve(
    repoRoot,
    process.env.AGENTS_RUN_FILE ?? 'charts/agents/examples/agentrun-workflow-smoke.yaml',
  )
  const agentRunName = process.env.AGENTS_RUN_NAME ?? 'agents-workflow-smoke'
  const workflowStepsExpectedEnv = process.env.AGENTS_WORKFLOW_STEPS_EXPECTED
  const timeoutFlag = process.env.AGENTS_TIMEOUT ?? '5m'
  const timeoutMs = parseDurationMs(timeoutFlag, 5 * 60 * 1000)
  const createNamespace = parseBoolean(process.env.AGENTS_CREATE_NAMESPACE, true)
  const dbBootstrap = parseBoolean(process.env.AGENTS_DB_BOOTSTRAP, false)
  const dbUrl = process.env.AGENTS_DB_URL ?? ''
  const dbUser = process.env.AGENTS_DB_USER ?? 'agents'
  const dbName = process.env.AGENTS_DB_NAME ?? 'agents'
  const dbHost = process.env.AGENTS_DB_HOST ?? `${releaseName}-postgres`
  const dbPort = process.env.AGENTS_DB_PORT ?? '5432'
  const dbImage = process.env.AGENTS_DB_IMAGE ?? 'pgvector/pgvector:pg16'
  const agentctlBin = process.env.AGENTCTL_BIN ?? 'agentctl'
  const kubeconfigPath =
    process.env.AGENTCTL_KUBECONFIG ?? process.env.KUBECONFIG ?? resolve(homedir(), '.kube', 'config')
  const caFile = process.env.KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
  const imageRepository = process.env.AGENTS_IMAGE_REPOSITORY
  const imageTag = process.env.AGENTS_IMAGE_TAG
  const imageDigestSet = Object.prototype.hasOwnProperty.call(process.env, 'AGENTS_IMAGE_DIGEST')
  const imageDigest = process.env.AGENTS_IMAGE_DIGEST ?? ''

  const agentctlCommand = agentctlBin.endsWith('.js') ? ['node', agentctlBin] : [agentctlBin]
  const agentctlExecutable = agentctlCommand[0]
  if (agentctlExecutable.includes('/') || agentctlExecutable.startsWith('.')) {
    if (!existsSync(agentctlExecutable)) {
      fatal(`Agentctl binary not found at ${agentctlExecutable}`)
    }
  } else {
    ensureCli(agentctlExecutable)
  }

  if (!existsSync(valuesFile)) {
    fatal(`Values file not found: ${valuesFile}`)
  }
  if (!existsSync(agentRunFile)) {
    fatal(`AgentRun file not found: ${agentRunFile}`)
  }

  await waitForKubectlApi(60_000)

  if (dbBootstrap) {
    await ensureNamespace(namespace, createNamespace)

    let databaseUrl = dbUrl
    let dbPassword = process.env.AGENTS_DB_PASSWORD
    if (!databaseUrl) {
      dbPassword = dbPassword ?? randomBytes(12).toString('hex')
      databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}?sslmode=disable`
    }

    log('Bootstrapping postgres for smoke test...')
    await applyYaml(
      namespace,
      `apiVersion: v1
kind: Service
metadata:
  name: ${dbHost}
spec:
  selector:
    app: ${dbHost}
  ports:
    - port: ${dbPort}
      targetPort: ${dbPort}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${dbHost}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${dbHost}
  template:
    metadata:
      labels:
        app: ${dbHost}
    spec:
      containers:
        - name: postgres
          image: ${dbImage}
          env:
            - name: POSTGRES_USER
              value: ${dbUser}
            - name: POSTGRES_PASSWORD
              value: ${dbPassword ?? 'generated'}
            - name: POSTGRES_DB
              value: ${dbName}
          ports:
            - containerPort: ${dbPort}
          readinessProbe:
            tcpSocket:
              port: ${dbPort}
            initialDelaySeconds: 5
            periodSeconds: 5
`,
    )

    await run('kubectl', ['-n', namespace, 'rollout', 'status', `deploy/${dbHost}`, `--timeout=${timeoutFlag}`])

    log('Ensuring required Postgres extensions for Jangar...')
    const podResult = await execCapture([
      'kubectl',
      '-n',
      namespace,
      'get',
      'pod',
      '-l',
      `app=${dbHost}`,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ])
    const dbPod = podResult.exitCode === 0 ? podResult.stdout : ''
    if (!dbPod) {
      fatal(`Failed to resolve Postgres pod name for ${dbHost}.`, podResult.stderr)
    }

    // Jangar requires both pgvector (vector) and pgcrypto extensions.
    // Even after the pod is Ready, Postgres may still be finalizing startup; retry briefly.
    const extensionSql = 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
    const extensionDeadlineMs = 60_000
    const extensionStart = Date.now()
    while (Date.now() - extensionStart <= extensionDeadlineMs) {
      const exitCode = await runInherit([
        'kubectl',
        '-n',
        namespace,
        'exec',
        dbPod,
        '--',
        'psql',
        '-U',
        dbUser,
        '-d',
        dbName,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        extensionSql,
      ])
      if (exitCode === 0) break
      await sleep(2000)
    }
    if (Date.now() - extensionStart > extensionDeadlineMs) {
      fatal(`Timed out ensuring Postgres extensions in pod ${dbPod}.`)
    }

    process.env.AGENTS_DB_URL = databaseUrl
  }

  const helmArgs = buildHelmArgs({
    releaseName,
    namespace,
    valuesFile,
    createNamespace,
    databaseUrl: process.env.AGENTS_DB_URL,
    imageRepository,
    imageTag,
    imageDigestSet,
    imageDigest,
  })

  log('Applying Agents chart CRDs...')
  await run('kubectl', buildKubectlApplyCrdsArgs())
  await run('kubectl', buildKubectlWaitForCrdsArgs())

  await run('helm', helmArgs)
  {
    const exitCode = await runInherit([
      'kubectl',
      '-n',
      namespace,
      'rollout',
      'status',
      `deploy/${releaseName}`,
      `--timeout=${timeoutFlag}`,
    ])
    if (exitCode !== 0) {
      await dumpNamespaceDiagnostics(namespace, releaseName)
      fatal(
        `Command failed (${exitCode}): kubectl -n ${namespace} rollout status deploy/${releaseName} --timeout=${timeoutFlag}`,
      )
    }
  }

  await run(
    'kubectl',
    buildKubectlApplyArgs({
      namespace,
      file: resolve(repoRoot, 'charts/agents/examples/agentprovider-smoke.yaml'),
    }),
  )
  await run(
    'kubectl',
    buildKubectlApplyArgs({
      namespace,
      file: resolve(repoRoot, 'charts/agents/examples/agent-smoke.yaml'),
    }),
  )
  await run(
    'kubectl',
    buildKubectlApplyArgs({
      namespace,
      file: resolve(repoRoot, 'charts/agents/examples/implementationspec-smoke.yaml'),
    }),
  )

  await run('kubectl', ['-n', namespace, 'delete', 'agentrun', agentRunName, '--ignore-not-found'])

  log('Submitting workflow AgentRun via agentctl...')
  const agentctlEnv: Record<string, string | undefined> = {
    AGENTCTL_NAMESPACE: namespace,
    AGENTCTL_MODE: 'kube',
    AGENTCTL_KUBECONFIG: kubeconfigPath,
  }
  if (existsSync(caFile)) {
    agentctlEnv.NODE_EXTRA_CA_CERTS = caFile
  }
  await run(agentctlCommand[0], [...agentctlCommand.slice(1), '--kube', '--yes', 'apply', '-f', agentRunFile], {
    env: agentctlEnv,
  })

  await waitForAgentRun(namespace, agentRunName, 60_000)

  const expectedSteps = workflowStepsExpectedEnv
    ? Number.parseInt(workflowStepsExpectedEnv, 10)
    : await getWorkflowSteps(namespace, agentRunName)

  if (!expectedSteps || Number.isNaN(expectedSteps) || expectedSteps < 1) {
    await run('kubectl', ['-n', namespace, 'get', 'agentrun', agentRunName, '-o', 'yaml'])
    fatal(`Workflow steps expected must be >= 1 (got ${expectedSteps}).`)
  }

  await waitForJobs(namespace, agentRunName, expectedSteps, timeoutMs)
  await waitForPhase(namespace, agentRunName, 'Succeeded', timeoutMs)

  log('Smoke test succeeded.')
}

if (import.meta.main) {
  main().catch((error) => fatal('Smoke test failed', error))
}
