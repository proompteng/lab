#!/usr/bin/env bun

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { buildAndPushDockerImage, inspectImageDigest, inspectImageDigestForPlatform } from '../shared/docker'
import { buildImage } from './build-image'

const manifestPath = resolve(repoRoot, 'argocd/applications/torghut/knative-service.yaml')
const websocketDeploymentPath = resolve(repoRoot, 'argocd/applications/torghut/ws/deployment.yaml')
const websocketKustomizePath = resolve(repoRoot, 'argocd/applications/torghut/ws')
const taDeploymentPath = resolve(
  repoRoot,
  process.env.TORGHUT_TA_DEPLOYMENT_PATH ?? 'argocd/applications/torghut/ta/flinkdeployment.yaml',
)
const taKustomizePath = resolve(repoRoot, process.env.TORGHUT_TA_KUSTOMIZE_PATH ?? 'argocd/applications/torghut/ta')
const databaseSecretName = 'torghut-db-app'
const databaseNamespace = 'torghut'
const databaseService = 'svc/torghut-db-rw'
const databasePort = 5432
const defaultMigrationAttempts = 3

type PortForwardHandle = {
  localPort: number
  stop: () => Promise<void>
}

type RunOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
}

type DeploymentStatus = {
  desired: number
  updated: number
  ready: number
  available: number
}

const ensureTools = () => {
  ensureCli('docker')
  ensureCli('kn')
  ensureCli('kubectl')
  ensureCli('uv')
}

const buildEnv = (env?: Record<string, string | undefined>) => {
  const source = env ? { ...process.env, ...env } : process.env
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Record<string, string>
}

const runWithStatus = async (command: string, args: string[], options: RunOptions = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`.trim())
  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdout: 'inherit',
    stderr: 'inherit',
  })

  return subprocess.exited
}

const runCapture = async (command: string, args: string[], options: RunOptions = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`.trim())
  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = subprocess.stdout ? await new Response(subprocess.stdout).text() : ''
  const stderr = subprocess.stderr ? await new Response(subprocess.stderr).text() : ''
  const exitCode = await subprocess.exited

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

const applyKnativeService = async (force: boolean): Promise<{ exitCode: number; combinedOutput: string }> => {
  const waitTimeout = process.env.TORGHUT_KN_WAIT_TIMEOUT ?? '300'
  const args = [
    'service',
    'apply',
    'torghut',
    '--namespace',
    'torghut',
    '--filename',
    manifestPath,
    '--wait',
    '--wait-timeout',
    waitTimeout,
  ]

  if (force) {
    args.push('--force')
  }

  const { exitCode, stdout, stderr } = await runCapture('kn', args)
  return { exitCode, combinedOutput: `${stdout}\n${stderr}`.trim() }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const capture = async (command: string, args: string[]): Promise<string> => {
  const subprocess = Bun.spawn([command, ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = subprocess.stdout ? await new Response(subprocess.stdout).text() : ''
  const stderr = subprocess.stderr ? await new Response(subprocess.stderr).text() : ''
  const exitCode = await subprocess.exited

  if (exitCode !== 0) {
    console.error(stderr.trim() || `Command ${command} ${args.join(' ')} failed`)
    fatal(`Command failed (${exitCode}): ${command} ${args.join(' ')}`)
  }

  return stdout
}

const decodeDatabaseSecret = async (): Promise<string> => {
  const encoded = (
    await capture('kubectl', [
      'get',
      'secret',
      databaseSecretName,
      '-n',
      databaseNamespace,
      '-o',
      'jsonpath={.data.uri}',
    ])
  ).trim()

  if (!encoded) {
    fatal(`Secret ${databaseNamespace}/${databaseSecretName} does not contain a uri key`)
  }
  try {
    return Buffer.from(encoded, 'base64').toString('utf8')
  } catch (error) {
    fatal('Failed to decode database connection string from secret', error)
  }
}

const resolveDatabaseUrl = async (): Promise<string> => {
  if (process.env.DB_DSN) {
    console.log('Using database URL from DB_DSN environment variable')
    return process.env.DB_DSN
  }
  console.log(`Fetching database URL from secret ${databaseNamespace}/${databaseSecretName}`)
  return decodeDatabaseSecret()
}

const startPortForward = async (): Promise<PortForwardHandle> => {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('kubectl', ['port-forward', '-n', databaseNamespace, databaseService, `0:${databasePort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill('SIGINT')
        rejectPromise(new Error('Timed out establishing kubectl port-forward'))
      }
    }, 15_000)

    const handleForwardingLine = (text: string) => {
      const match = text.match(/Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)/)
      if (match && !resolved) {
        resolved = true
        clearTimeout(timeout)
        const localPort = Number(match[1])
        console.log(`kubectl port-forward established on 127.0.0.1:${localPort}`)
        const killOnExit = () => {
          if (child.exitCode === null) {
            child.kill('SIGINT')
          }
        }
        const teardownHooks = () => {
          process.off('exit', killOnExit)
          process.off('SIGINT', killOnExit)
          process.off('SIGTERM', killOnExit)
        }
        process.on('exit', killOnExit)
        process.on('SIGINT', killOnExit)
        process.on('SIGTERM', killOnExit)
        const stop = async () => {
          teardownHooks()
          if (child.exitCode !== null || child.signalCode) {
            return
          }
          child.kill('SIGINT')
          await once(child, 'exit')
        }
        resolvePromise({ localPort, stop })
      }
    }

    const logStream = (prefix: 'stdout' | 'stderr', data: Buffer) => {
      const text = data.toString()
      const stream = prefix === 'stdout' ? process.stdout : process.stderr
      stream.write(`[kubectl port-forward] ${text}`)
      handleForwardingLine(text)
      if (/error/i.test(text) && !resolved) {
        clearTimeout(timeout)
        resolved = true
        if (child.exitCode === null) {
          child.kill('SIGINT')
        }
        rejectPromise(new Error(text.trim()))
      }
    }

    child.stdout?.on('data', (data) => logStream('stdout', data))
    child.stderr?.on('data', (data) => logStream('stderr', data))

    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (!resolved) {
        resolved = true
        rejectPromise(new Error(`kubectl port-forward exited with code ${code ?? 0}`))
      }
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      if (!resolved) {
        resolved = true
        rejectPromise(error)
      }
    })
  })
}

const rewriteDatabaseUrl = (databaseUrl: string, localPort: number): string => {
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch (error) {
    fatal('Invalid database URL; unable to parse for port-forwarding', error)
  }
  parsed.hostname = '127.0.0.1'
  parsed.port = String(localPort)
  return parsed.toString()
}

const runMigrations = async () => {
  if (process.env.TORGHUT_SKIP_MIGRATIONS === 'true') {
    console.log('Skipping torghut DB migrations (TORGHUT_SKIP_MIGRATIONS=true)')
    return
  }
  const databaseUrl = await resolveDatabaseUrl()
  const attempts = Number.parseInt(process.env.TORGHUT_MIGRATION_ATTEMPTS ?? '', 10) || defaultMigrationAttempts

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let forward: PortForwardHandle | null = null
    try {
      forward = await startPortForward()
      const localUrl = rewriteDatabaseUrl(databaseUrl, forward.localPort)
      console.log(`Running torghut migrations via local port-forwarded connection (attempt ${attempt}/${attempts})`)
      const exitCode = await runWithStatus('uv', ['run', 'alembic', 'upgrade', 'head'], {
        cwd: resolve(repoRoot, 'services/torghut'),
        env: {
          DB_DSN: localUrl,
        },
      })
      if (exitCode === 0) {
        return
      }
      throw new Error(`alembic exited with code ${exitCode}`)
    } catch (error) {
      if (attempt === attempts) {
        fatal('Failed to run torghut migrations after multiple attempts', error)
      }
      console.warn(`Migration attempt ${attempt} failed; retrying...`)
      await delay(2000 * attempt)
    } finally {
      if (forward) {
        await forward.stop()
        console.log('kubectl port-forward closed')
      }
    }
  }
}

const updateManifest = (image: string, version: string, commit: string) => {
  const raw = readFileSync(manifestPath, 'utf8')
  const doc = YAML.parse(raw)

  const containers:
    | Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }>
    | undefined = doc?.spec?.template?.spec?.containers

  if (!containers || containers.length === 0) {
    throw new Error('Unable to locate torghut container in manifest')
  }

  const container = containers.find((item) => item?.name === 'user-container') ?? containers[0]
  container.image = image
  container.env ??= []

  const ensureEnv = (name: string, value: string) => {
    const existing = container.env?.find((entry) => entry?.name === name)
    if (existing) {
      existing.value = value
    } else {
      container.env?.push({ name, value })
    }
  }

  ensureEnv('TORGHUT_VERSION', version)
  ensureEnv('TORGHUT_COMMIT', commit)

  doc.spec ??= {}
  doc.spec.template ??= {}
  doc.spec.template.metadata ??= {}
  doc.spec.template.metadata.annotations ??= {}
  doc.spec.template.metadata.annotations['client.knative.dev/updateTimestamp'] = new Date().toISOString()

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  writeFileSync(manifestPath, updated)
  console.log(`Updated ${manifestPath} with image ${image}`)
}

const buildWebsocketImage = async () => {
  const registry = process.env.TORGHUT_WS_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.TORGHUT_WS_IMAGE_REPOSITORY ?? 'lab/torghut-ws'
  const tag = process.env.TORGHUT_WS_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, process.env.TORGHUT_WS_IMAGE_CONTEXT ?? 'services/dorvud')
  const dockerfile = resolve(
    repoRoot,
    process.env.TORGHUT_WS_IMAGE_DOCKERFILE ?? 'services/dorvud/websockets/Dockerfile',
  )
  const platforms = process.env.TORGHUT_WS_IMAGE_PLATFORMS?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.toLowerCase() !== 'none') ?? ['linux/arm64']
  const codexAuthPath = process.env.TORGHUT_WS_CODEX_AUTH_PATH

  return buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    platforms,
    codexAuthPath,
  })
}

const buildTechnicalAnalysisImage = async () => {
  const registry = process.env.TORGHUT_TA_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.TORGHUT_TA_IMAGE_REPOSITORY ?? 'lab/torghut-ta'
  const tag = process.env.TORGHUT_TA_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, process.env.TORGHUT_TA_IMAGE_CONTEXT ?? 'services/dorvud')
  const dockerfile = resolve(
    repoRoot,
    process.env.TORGHUT_TA_IMAGE_DOCKERFILE ?? 'services/dorvud/technical-analysis-flink/Dockerfile',
  )
  const platforms = process.env.TORGHUT_TA_IMAGE_PLATFORMS?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.toLowerCase() !== 'none') ?? ['linux/arm64']
  const codexAuthPath = process.env.TORGHUT_TA_CODEX_AUTH_PATH

  return buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    platforms,
    codexAuthPath,
  })
}

const updateWebsocketDeployment = (image: string, version: string, commit: string) => {
  const raw = readFileSync(websocketDeploymentPath, 'utf8')
  const doc = YAML.parse(raw)

  const containers:
    | Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }>
    | undefined = doc?.spec?.template?.spec?.containers

  if (!containers || containers.length === 0) {
    throw new Error('Unable to locate torghut-ws container in manifest')
  }

  const container = containers.find((item) => item?.name === 'torghut-ws') ?? containers[0]
  container.image = image
  container.env ??= []

  const ensureEnv = (name: string, value: string) => {
    const existing = container.env?.find((entry) => entry?.name === name)
    if (existing) {
      existing.value = value
    } else {
      container.env?.push({ name, value })
    }
  }

  ensureEnv('TORGHUT_WS_VERSION', version)
  ensureEnv('TORGHUT_WS_COMMIT', commit)

  doc.spec ??= {}
  doc.spec.template ??= {}
  doc.spec.template.metadata ??= {}
  doc.spec.template.metadata.annotations ??= {}
  doc.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString()

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  writeFileSync(websocketDeploymentPath, updated)
  console.log(`Updated ${websocketDeploymentPath} with image ${image}`)
}

const updateTechnicalAnalysisDeployment = (image: string, version: string, commit: string) => {
  if (!existsSync(taDeploymentPath)) {
    fatal(`Technical analysis deployment manifest not found at ${taDeploymentPath}; set TORGHUT_TA_DEPLOYMENT_PATH.`)
  }

  const raw = readFileSync(taDeploymentPath, 'utf8')
  const doc = YAML.parse(raw)

  doc.spec ??= {}
  doc.spec.image = image

  const containers:
    | Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }>
    | undefined = doc?.spec?.podTemplate?.spec?.containers

  if (!containers || containers.length === 0) {
    throw new Error('Unable to locate flink container in FlinkDeployment manifest')
  }

  const container = containers.find((item) => item?.name === 'flink-main-container') ?? containers[0]
  container.env ??= []

  const ensureEnv = (name: string, value: string) => {
    const existing = container.env?.find((entry) => entry?.name === name)
    if (existing) {
      existing.value = value
    } else {
      container.env?.push({ name, value })
    }
  }

  ensureEnv('TORGHUT_TA_VERSION', version)
  ensureEnv('TORGHUT_TA_COMMIT', commit)

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  writeFileSync(taDeploymentPath, updated)
  console.log(`Updated ${taDeploymentPath} with image ${image}`)
}

const resolveDeploymentReplicas = async (deploymentName: string): Promise<number> => {
  const raw = (
    await capture('kubectl', [
      '-n',
      databaseNamespace,
      'get',
      'deployment',
      deploymentName,
      '-o',
      'jsonpath={.spec.replicas}',
    ])
  ).trim()
  const replicas = Number.parseInt(raw, 10)
  return Number.isFinite(replicas) && replicas > 0 ? replicas : 1
}

const readDeploymentStatus = async (deploymentName: string): Promise<DeploymentStatus> => {
  const raw = await capture('kubectl', ['-n', databaseNamespace, 'get', 'deployment', deploymentName, '-o', 'json'])
  const parsed = JSON.parse(raw) as {
    spec?: { replicas?: number }
    status?: {
      updatedReplicas?: number
      readyReplicas?: number
      availableReplicas?: number
    }
  }
  const desired = Number(parsed?.spec?.replicas ?? 1)
  return {
    desired: Number.isFinite(desired) && desired > 0 ? desired : 1,
    updated: Number(parsed?.status?.updatedReplicas ?? 0),
    ready: Number(parsed?.status?.readyReplicas ?? 0),
    available: Number(parsed?.status?.availableReplicas ?? 0),
  }
}

const formatDeploymentStatus = (status: DeploymentStatus) =>
  `desired=${status.desired} updated=${status.updated} ready=${status.ready} available=${status.available}`

const isDeploymentReady = (status: DeploymentStatus) =>
  status.ready >= status.desired && status.available >= status.desired && status.updated >= status.desired

const deploymentReady = async (deploymentName: string, context: string) => {
  const status = await readDeploymentStatus(deploymentName)
  const formatted = formatDeploymentStatus(status)
  if (isDeploymentReady(status)) {
    console.log(`${deploymentName} deployment ready (${context}): ${formatted}`)
    return true
  }
  console.warn(`${deploymentName} deployment not ready (${context}): ${formatted}`)
  return false
}

const applyManifest = async () => {
  const initial = await applyKnativeService(false)
  if (initial.exitCode === 0) {
    return
  }

  if (
    initial.combinedOutput.includes('annotation value is immutable: metadata.annotations.serving.knative.dev/creator')
  ) {
    console.warn('Detected immutable Knative creator annotation; retrying with --force')
    const forced = await applyKnativeService(true)
    if (forced.exitCode === 0) {
      return
    }
    fatal('kn service apply --force failed; check knative service admission and permissions', {
      initial,
      forced,
    })
  }

  fatal(`kn service apply failed: ${initial.combinedOutput || 'unknown error'}`)
}

const applyWebsocketResources = async () => {
  const waitTimeout = '300s'
  await run('kubectl', ['apply', '-k', websocketKustomizePath])
  const rolloutExit = await runWithStatus('kubectl', [
    '-n',
    databaseNamespace,
    'rollout',
    'status',
    'deployment/torghut-ws',
    `--timeout=${waitTimeout}`,
  ])

  if (rolloutExit === 0) {
    return
  }

  console.warn('torghut-ws rollout timed out; forcing a single-replica restart to clear Alpaca connection limits')
  const desiredReplicas = await resolveDeploymentReplicas('torghut-ws')
  await run('kubectl', ['-n', databaseNamespace, 'scale', 'deployment/torghut-ws', '--replicas=0'])
  await run('kubectl', ['-n', databaseNamespace, 'scale', 'deployment/torghut-ws', `--replicas=${desiredReplicas}`])
  const availableExit = await runWithStatus('kubectl', [
    '-n',
    databaseNamespace,
    'wait',
    '--for=condition=available',
    'deployment/torghut-ws',
    `--timeout=${waitTimeout}`,
  ])

  if (availableExit !== 0 && !(await deploymentReady('torghut-ws', 'after restart wait'))) {
    fatal('torghut-ws failed to become ready after restart')
  }

  const restartRolloutExit = await runWithStatus('kubectl', [
    '-n',
    databaseNamespace,
    'rollout',
    'status',
    'deployment/torghut-ws',
    `--timeout=${waitTimeout}`,
  ])

  if (restartRolloutExit !== 0 && !(await deploymentReady('torghut-ws', 'after restart rollout'))) {
    fatal('torghut-ws failed to roll out after restart')
  }
}

const applyTechnicalAnalysisResources = async () => {
  if (!existsSync(taKustomizePath)) {
    fatal(`Technical analysis kustomize directory not found at ${taKustomizePath}; set TORGHUT_TA_KUSTOMIZE_PATH.`)
  }

  await run('kubectl', ['apply', '-k', taKustomizePath])
}

const main = async () => {
  ensureTools()

  const defaultPlatform = process.env.TORGHUT_IMAGE_PLATFORM ?? 'linux/arm64'
  const { image, version, commit } = await buildImage()
  const digestRef = inspectImageDigestForPlatform(image, defaultPlatform) ?? inspectImageDigest(image)

  const websocketImage = await buildWebsocketImage()
  const websocketPlatform = process.env.TORGHUT_WS_IMAGE_PLATFORM ?? defaultPlatform
  const websocketDigestRef =
    inspectImageDigestForPlatform(websocketImage.image, websocketPlatform) ?? inspectImageDigest(websocketImage.image)

  const taImage = await buildTechnicalAnalysisImage()
  const taPlatform = process.env.TORGHUT_TA_IMAGE_PLATFORM ?? defaultPlatform
  const taDigestRef = inspectImageDigestForPlatform(taImage.image, taPlatform) ?? inspectImageDigest(taImage.image)

  updateManifest(digestRef, version, commit)
  updateWebsocketDeployment(websocketDigestRef, version, commit)
  updateTechnicalAnalysisDeployment(taDigestRef, version, commit)
  await runMigrations()
  await applyManifest()
  await applyWebsocketResources()
  await applyTechnicalAnalysisResources()

  console.log(
    'torghut deployment updated (app + websocket forwarder + technical analysis); commit manifest changes for Argo CD reconciliation.',
  )
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to deploy torghut', error))
}
