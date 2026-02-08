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

const isTransientKubectlError = (text: string) =>
  /unable to connect to the server|connection reset by peer|context deadline exceeded|i\/o timeout|tls handshake timeout|eof/i.test(
    text.toLowerCase(),
  )

const waitForKubectlReady = async (timeoutMs: number) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await execCapture(['kubectl', 'get', 'nodes', '--request-timeout=10s'])
    if (result.exitCode === 0) return
    if (!isTransientKubectlError(`${result.stdout}\n${result.stderr}`)) {
      fatal('kubectl is not functional against the current cluster context.', `${result.stdout}\n${result.stderr}`)
    }
    await sleep(1000)
  }
  fatal(`Timed out waiting for kubectl to reach the API server (${timeoutMs}ms).`)
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
  const subprocess = Bun.spawn(['kubectl', '-n', namespace, 'apply', '-f', '-'], {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  subprocess.stdin?.write(manifest)
  subprocess.stdin?.end()

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

  // kind-action "wait" can still return before kubectl is fully stable; guard against transient API resets.
  const kubeReadyTimeoutMs = parseDurationMs(process.env.AGENTS_KUBE_READY_TIMEOUT, 120 * 1000)
  await waitForKubectlReady(kubeReadyTimeoutMs)

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
  const agentctlBin = process.env.AGENTCTL_BIN ?? 'agentctl'
  const kubeconfigPath =
    process.env.AGENTCTL_KUBECONFIG ?? process.env.KUBECONFIG ?? resolve(homedir(), '.kube', 'config')
  const caFile = process.env.KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'

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

  if (dbBootstrap) {
    const namespaceCheck = await execCapture(['kubectl', 'get', 'namespace', namespace])
    if (namespaceCheck.exitCode !== 0) {
      if (/forbidden|cannot/i.test(namespaceCheck.stderr)) {
        if (createNamespace) {
          fatal(`Insufficient permissions to verify or create namespace ${namespace}.`, namespaceCheck.stderr)
        }
        log(`Skipping namespace existence check for ${namespace} due to RBAC.`)
      } else if (createNamespace) {
        await run('kubectl', ['create', 'namespace', namespace])
      } else {
        fatal(`Namespace ${namespace} does not exist and AGENTS_CREATE_NAMESPACE=false.`)
      }
    }

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
          image: postgres:16-alpine
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
    process.env.AGENTS_DB_URL = databaseUrl
  }

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

  if (process.env.AGENTS_DB_URL) {
    helmArgs.push('--set-string', `database.url=${process.env.AGENTS_DB_URL}`)
  }

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

  await run('kubectl', [
    '-n',
    namespace,
    'apply',
    '-f',
    resolve(repoRoot, 'charts/agents/examples/agentprovider-smoke.yaml'),
  ])
  await run('kubectl', ['-n', namespace, 'apply', '-f', resolve(repoRoot, 'charts/agents/examples/agent-smoke.yaml')])
  await run('kubectl', [
    '-n',
    namespace,
    'apply',
    '-f',
    resolve(repoRoot, 'charts/agents/examples/implementationspec-smoke.yaml'),
  ])

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
