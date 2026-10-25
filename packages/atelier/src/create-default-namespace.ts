#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { status as GrpcStatus } from '@grpc/grpc-js'
import { CoreV1Api, KubeConfig, PortForward } from '@kubernetes/client-node'
import type { TLSConfig } from '@temporalio/client'
import { Connection, isGrpcServiceError } from '@temporalio/client'

type CliOptions = {
  namespace?: string
  retentionDays?: number
  description?: string
  ownerEmail?: string
  apiKey?: string
  tlsEnabled?: boolean
  caCertPath?: string
  clientCertPath?: string
  clientKeyPath?: string
  serverNameOverride?: string
  grpcPort?: number
  localPort?: number
  kubeNamespace?: string
  kubeLabelSelector?: string
  kubeContext?: string
  allowInsecureTls?: boolean
  kubeResource?: string
  kubectlBin?: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i]
    const next = argv[i + 1]
    switch (current) {
      case '-n':
      case '--namespace':
        options.namespace = expectValue(current, next)
        i += 1
        break
      case '-r':
      case '--retention-days':
        options.retentionDays = parsePositiveNumber(expectValue(current, next), current)
        i += 1
        break
      case '-d':
      case '--description':
        options.description = expectValue(current, next)
        i += 1
        break
      case '-o':
      case '--owner-email':
        options.ownerEmail = expectValue(current, next)
        i += 1
        break
      case '-k':
      case '--api-key':
        options.apiKey = expectValue(current, next)
        i += 1
        break
      case '--tls':
        options.tlsEnabled = true
        break
      case '--ca-cert':
        options.caCertPath = expectValue(current, next)
        i += 1
        break
      case '--cert':
        options.clientCertPath = expectValue(current, next)
        i += 1
        break
      case '--key':
        options.clientKeyPath = expectValue(current, next)
        i += 1
        break
      case '--server-name':
        options.serverNameOverride = expectValue(current, next)
        i += 1
        break
      case '-p':
      case '--port':
      case '--grpc-port':
        options.grpcPort = parsePort(expectValue(current, next), current)
        i += 1
        break
      case '--local-port':
        options.localPort = parsePort(expectValue(current, next), current)
        i += 1
        break
      case '--kube-namespace':
        options.kubeNamespace = expectValue(current, next)
        i += 1
        break
      case '--kube-label-selector':
        options.kubeLabelSelector = expectValue(current, next)
        i += 1
        break
      case '--kube-context':
        options.kubeContext = expectValue(current, next)
        i += 1
        break
      case '--kube-resource':
        options.kubeResource = expectValue(current, next)
        i += 1
        break
      case '--kubectl-bin':
        options.kubectlBin = expectValue(current, next)
        i += 1
        break
      case '--allow-insecure':
        options.allowInsecureTls = true
        break
      default:
        // Ignore unknown flags to stay forward-compatible
        break
    }
  }
  return options
}

function expectValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function parsePositiveNumber(raw: string, flag: string): number {
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid number provided to ${flag}: ${raw}`)
  }
  return parsed
}

function parsePort(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port provided to ${flag}: ${raw}`)
  }
  return parsed
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined
  }
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) {
    return false
  }
  return undefined
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addressInfo = server.address()
      if (addressInfo && typeof addressInfo !== 'string') {
        const { port } = addressInfo
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve(port)
          }
        })
      } else {
        server.close()
        reject(new Error('Unable to allocate ephemeral port'))
      }
    })
  })
}

type PortForwardHandle = {
  localPort: number
  address: string
  stop: () => Promise<void>
}

type PortForwardOptions = {
  namespace: string
  labelSelector: string
  remotePort: number
  localPort?: number
  kubeContext?: string
  kubeResource?: string
  kubectlBin?: string
}

async function selectTemporalPod(options: {
  kubeConfig: KubeConfig
  namespace: string
  labelSelector: string
}): Promise<{ name: string }> {
  const core = options.kubeConfig.makeApiClient(CoreV1Api)
  const list = await core.listNamespacedPod({
    namespace: options.namespace,
    labelSelector: options.labelSelector,
  })
  const pods = list?.items ?? []
  const pod = pods.find((item) => item.status?.phase === 'Running' && item.metadata?.name)
  if (!pod?.metadata?.name) {
    throw new Error(`No running pods found in namespace=${options.namespace} for selector="${options.labelSelector}"`)
  }
  return { name: pod.metadata.name }
}

async function startKubePortForward(options: PortForwardOptions): Promise<PortForwardHandle> {
  const kubeConfig = new KubeConfig()
  kubeConfig.loadFromDefault()
  if (options.kubeContext) {
    kubeConfig.setCurrentContext(options.kubeContext)
  }

  const portForward = new PortForward(kubeConfig)
  const localPort = options.localPort ?? (await findFreePort())
  const pod = await selectTemporalPod({
    kubeConfig,
    namespace: options.namespace,
    labelSelector: options.labelSelector,
  })

  const activeSockets = new Set<{ close: () => void }>()
  const server = net.createServer((socket) => {
    socket.setNoDelay(true)
    const errStream = new PassThrough()
    errStream.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim()
      if (message.length > 0) {
        console.warn(`[port-forward stderr] ${message}`)
      }
    })

    portForward
      .portForward(options.namespace, pod.name, [options.remotePort], socket, errStream, socket)
      .then((ws) => {
        activeSockets.add(ws)
        socket.on('close', () => {
          try {
            activeSockets.delete(ws)
            ws.close()
          } catch {
            // ignore
          }
        })
      })
      .catch((error) => {
        console.error('Failed to establish port-forward stream:', error)
        socket.destroy(error instanceof Error ? error : undefined)
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, '127.0.0.1', () => resolve())
  })

  const stop = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    for (const ws of activeSockets) {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
    activeSockets.clear()
  }

  console.log(
    `Port-forward ready: namespace=${options.namespace} pod=${pod.name} -> 127.0.0.1:${localPort} (remote ${options.remotePort})`,
  )

  return {
    localPort,
    address: `127.0.0.1:${localPort}`,
    stop,
  }
}

function isKubeAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const maybe = error as { statusCode?: number; response?: { statusCode?: number }; body?: unknown }
  const code = maybe.statusCode ?? maybe.response?.statusCode
  return code === 401 || code === 403
}

async function getKubectlPath(explicit?: string) {
  if (explicit) {
    return explicit
  }
  if (process.env.KUBECTL_BIN) {
    return process.env.KUBECTL_BIN
  }
  return 'kubectl'
}

async function startKubectlPortForward(options: PortForwardOptions): Promise<PortForwardHandle> {
  const kubectl = await getKubectlPath(options.kubectlBin)
  const localPort = options.localPort ?? (await findFreePort())
  const target = options.kubeResource || 'svc/temporal-frontend'
  const args = ['port-forward', target, `${localPort}:${options.remotePort}`, '--address', '127.0.0.1']
  if (options.namespace) {
    args.unshift('--namespace', options.namespace)
  }
  if (options.kubeContext) {
    args.unshift('--context', options.kubeContext)
  }

  console.warn('Falling back to kubectl port-forward:', [kubectl, ...args].join(' '))

  const child = spawn(kubectl, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const handleLine = (data: Buffer) => {
      const text = data.toString('utf8')
      if (!settled && /Forwarding from 127\.0\.0\.1:\d+ ->/.test(text)) {
        settled = true
        resolve()
      }
    }

    child.stdout.on('data', handleLine)
    child.stderr.on('data', handleLine)
    child.once('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.once('exit', (code, signal) => {
      if (!settled) {
        settled = true
        reject(new Error(`kubectl port-forward exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
      }
    })
  })

  await ready

  const stop = async () => {
    if (!child.killed) {
      child.kill('SIGINT')
    }
    await once(child, 'exit').catch(() => {
      // ignore
    })
  }

  return {
    localPort,
    address: `127.0.0.1:${localPort}`,
    stop,
  }
}

async function ensurePortForward(options: PortForwardOptions): Promise<PortForwardHandle> {
  try {
    return await startKubePortForward(options)
  } catch (error) {
    if (isKubeAuthError(error)) {
      console.warn('Kubernetes client API authentication failed; attempting kubectl fallback.')
      return await startKubectlPortForward(options)
    }
    console.warn('Kubernetes client port-forward failed:', error)
    console.warn('Attempting kubectl fallback.')
    return await startKubectlPortForward(options)
  }
}

async function buildTlsConfig(options: CliOptions): Promise<TLSConfig | undefined> {
  const needsTls = Boolean(
    options.tlsEnabled ||
    options.caCertPath ||
    options.clientCertPath ||
    options.clientKeyPath ||
    options.serverNameOverride,
  )
  if (!needsTls) {
    return undefined
  }

  const tlsConfig: TLSConfig = {}

  if (options.caCertPath) {
    tlsConfig.ca = await readFile(options.caCertPath)
  }

  if (options.clientCertPath || options.clientKeyPath) {
    if (!options.clientCertPath || !options.clientKeyPath) {
      throw new Error('Both --cert and --key must be supplied when configuring mTLS')
    }
    tlsConfig.clientCertPair = {
      cert: await readFile(options.clientCertPath),
      key: await readFile(options.clientKeyPath),
    }
  }

  if (options.serverNameOverride) {
    tlsConfig.serverNameOverride = options.serverNameOverride
  }

  return tlsConfig
}

async function describeNamespaceIfExists(connection: Connection, namespace: string) {
  try {
    return await connection.workflowService.describeNamespace({ namespace })
  } catch (err) {
    if (isGrpcServiceError(err) && err.code === GrpcStatus.NOT_FOUND) {
      return undefined
    }
    throw err
  }
}

function asRetention(retentionDays: number) {
  const seconds = Math.round(retentionDays * 24 * 60 * 60)
  return { seconds, nanos: 0 }
}

async function main() {
  let connection: Connection | undefined
  let portForwardHandle: PortForwardHandle | undefined
  try {
    const parsed = parseArgs(process.argv)
    const grpcPort =
      parsed.grpcPort ||
      (process.env.TEMPORAL_GRPC_PORT ? parsePort(process.env.TEMPORAL_GRPC_PORT, 'TEMPORAL_GRPC_PORT') : 7233)
    const allowInsecure =
      parsed.allowInsecureTls ?? parseBoolean(process.env.TEMPORAL_ALLOW_INSECURE ?? process.env.ALLOW_INSECURE_TLS)
    if (allowInsecure) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }

    const namespace = parsed.namespace || process.env.TEMPORAL_NAMESPACE || 'default'
    const retentionDays = parsed.retentionDays || Number.parseFloat(process.env.TEMPORAL_RETENTION_DAYS || '') || 3
    const ownerEmail = parsed.ownerEmail || process.env.TEMPORAL_NAMESPACE_OWNER_EMAIL
    const description = parsed.description || process.env.TEMPORAL_NAMESPACE_DESCRIPTION
    const apiKey = parsed.apiKey || process.env.TEMPORAL_API_KEY || process.env.TEMPORAL_OPERATOR_API_KEY

    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      throw new Error(`Retention must be a positive number of days. Received: ${retentionDays}`)
    }

    const tls = await buildTlsConfig(parsed)

    const labelSelector =
      parsed.kubeLabelSelector ||
      process.env.TEMPORAL_KUBE_LABEL_SELECTOR ||
      'app.kubernetes.io/component=frontend,app.kubernetes.io/instance=temporal'
    const kubeNamespace = parsed.kubeNamespace || process.env.TEMPORAL_KUBE_NAMESPACE || 'temporal'
    if (!kubeNamespace) {
      throw new Error('Kubernetes namespace is required (set --kube-namespace or TEMPORAL_KUBE_NAMESPACE)')
    }

    portForwardHandle = await ensurePortForward({
      namespace: kubeNamespace,
      labelSelector,
      remotePort: grpcPort,
      localPort: parsed.localPort,
      kubeContext: parsed.kubeContext || process.env.TEMPORAL_KUBE_CONTEXT,
      kubeResource: parsed.kubeResource || process.env.TEMPORAL_KUBE_RESOURCE,
      kubectlBin: parsed.kubectlBin || process.env.KUBECTL_BIN,
    })

    const address = portForwardHandle.address
    console.log(`Connecting to Temporal at ${address}…`)
    connection = await Connection.connect({
      address,
      ...(tls ? { tls } : {}),
      ...(apiKey ? { apiKey } : {}),
    })

    const existing = await describeNamespaceIfExists(connection, namespace)
    if (existing) {
      const state = existing.namespaceInfo?.state
      console.log(`Namespace "${namespace}" already exists (state=${String(state)}). Nothing to do.`)
      return
    }

    console.log(`Namespace "${namespace}" not found. Creating with retention=${retentionDays} day(s)…`)
    await connection.workflowService.registerNamespace({
      namespace,
      description,
      ownerEmail,
      workflowExecutionRetentionPeriod: asRetention(retentionDays),
    })

    console.log(`Namespace "${namespace}" created successfully.`)
  } catch (error) {
    if (error instanceof Error) {
      console.error('Failed to ensure Temporal namespace:', error.message)
      if (error.cause instanceof Error && error.cause.message) {
        console.error('  Cause:', error.cause.message)
      }
    } else {
      console.error('Failed to ensure Temporal namespace:', error)
    }
    process.exitCode = 1
  } finally {
    if (connection) {
      await connection.close()
    }
    if (portForwardHandle) {
      await portForwardHandle.stop()
    }
  }
}

await main()
