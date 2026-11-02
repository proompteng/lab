#!/usr/bin/env bun

import { $ } from 'bun'

$.throws(true)

type ExecArgs = string[]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const homeDir = process.env.HOME ?? '~'
const sshUser = process.env.K3S_SSH_USER ?? 'kalmyk'
const sshKeyPath = process.env.K3S_SSH_KEY ?? `${homeDir}/.ssh/id_ed25519`
const kubeConfigPath = process.env.K3S_LOCAL_PATH ?? `${homeDir}/.kube/config`
const kubeContext = process.env.K3S_CONTEXT ?? 'default'
const primaryHost = process.env.K3S_PRIMARY_HOST ?? '192.168.1.150'
const apiLoadBalancer = process.env.K3S_API_LB ?? '192.168.1.200'
const k3sChannel = process.env.K3S_CHANNEL ?? 'latest'
const k3sVersion = process.env.K3S_VERSION

function readParallelism(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`Invalid parallelism value "${value}"`)
  }
  return parsed
}

const baseParallelism = readParallelism(process.env.K3S_PARALLELISM, 5)
const serverParallelism = readParallelism(process.env.K3S_SERVER_PARALLELISM, baseParallelism)
const workerParallelism = readParallelism(process.env.K3S_WORKER_PARALLELISM, baseParallelism)

const tlsSans = parseCsvList(process.env.K3S_TLS_SANS, [primaryHost, apiLoadBalancer].filter(Boolean) as string[])
const tlsSanArgs = tlsSans.map((san) => `--tls-san=${san}`)

const defaultServerExtraArgs = [
  ...tlsSanArgs,
  '--disable servicelb',
  '--flannel-backend=host-gw',
  '--etcd-arg=auto-compaction-mode=periodic',
  '--etcd-arg=auto-compaction-retention=1h',
  '--etcd-arg=quota-backend-bytes=8589934592',
  '--etcd-snapshot-schedule-cron="0 */6 * * *"',
  '--etcd-snapshot-retention=20',
  '--kube-proxy-arg=proxy-mode=ipvs',
  '--kube-proxy-arg=ipvs-scheduler=wrr',
  '--kubelet-arg=cpu-manager-policy=static',
  '--kubelet-arg=topology-manager-policy=single-numa-node',
  '--kubelet-arg=reserved-cpus=0-1',
  '--kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi',
  '--kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi',
  '--kubelet-arg=container-log-max-size=10Mi',
  '--kubelet-arg=container-log-max-files=3',
  '--kubelet-arg=serialize-image-pulls=false',
  '--node-taint=node-role.kubernetes.io/control-plane=true:NoSchedule',
].join(' ')

const defaultWorkerExtraArgs = [
  '--kubelet-arg=cpu-manager-policy=static',
  '--kubelet-arg=topology-manager-policy=single-numa-node',
  '--kubelet-arg=reserved-cpus=0-1',
  '--kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi',
  '--kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi',
  '--kubelet-arg=container-log-max-size=10Mi',
  '--kubelet-arg=container-log-max-files=3',
  '--kubelet-arg=serialize-image-pulls=false',
].join(' ')

const serverExtraArgs = process.env.K3S_SERVER_EXTRA_ARGS ?? defaultServerExtraArgs
const workerExtraArgs = process.env.K3S_WORKER_EXTRA_ARGS ?? defaultWorkerExtraArgs

const additionalServers = parseHostList(process.env.K3S_ADDITIONAL_SERVERS ?? '192.168.1.151,192.168.1.152')
const workerHosts = parseHostList(process.env.K3S_WORKER_HOSTS ?? '192.168.1.160-192.168.1.189')

function parseHostList(value: string) {
  return value
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap(expandHostSegment)
}

function expandHostSegment(segment: string): string[] {
  if (!segment.includes('-')) {
    validateHost(segment)
    return [segment]
  }

  const [startRaw, endRaw] = segment.split('-', 2)
  if (!endRaw) {
    validateHost(startRaw)
    return [startRaw]
  }

  const startParts = startRaw.split('.').map(Number)
  const endParts = endRaw.split('.').map(Number)

  if (startParts.length !== 4 || endParts.length !== 4) {
    throw new Error(`Invalid host range "${segment}"`)
  }

  const basePrefix = startParts.slice(0, 3).join('.')
  if (basePrefix !== endParts.slice(0, 3).join('.')) {
    throw new Error(`Host range must share the same /24 prefix: "${segment}"`)
  }

  const start = startParts[3]
  const end = endParts[3]

  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`Invalid host range boundaries: "${segment}"`)
  }
  if (end < start) {
    throw new Error(`Host range end is smaller than start: "${segment}"`)
  }

  validateOctet(start)
  validateOctet(end)

  const prefix = `${basePrefix}.`
  const hosts: string[] = []
  for (let octet = start; octet <= end; octet += 1) {
    hosts.push(`${prefix}${octet}`)
  }
  return hosts
}

function parseCsvList(value: string | undefined, fallback: string[]) {
  if (value === undefined) {
    return fallback
  }
  return value
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function validateHost(host: string) {
  const parts = host.split('.')
  if (parts.length !== 4) {
    throw new Error(`Invalid host "${host}"`)
  }
  parts.forEach((part) => {
    const value = Number(part)
    validateOctet(value)
  })
}

function validateOctet(value: number) {
  if (Number.isNaN(value) || value < 0 || value > 255) {
    throw new Error(`Invalid IP octet value "${value}"`)
  }
}

function shellEscape(part: string) {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part
}

async function exec(parts: ExecArgs, options: { capture?: boolean; silent?: boolean } = {}) {
  const command = parts.map(shellEscape).join(' ')
  if (!options.silent) {
    console.log(dryRun ? `$ (dry-run) ${command}` : `$ ${command}`)
  }
  if (dryRun) {
    return options.capture ? '' : undefined
  }
  const procBuilder = $`${{ raw: command }}`
  const proc = options.silent ? procBuilder.quiet() : procBuilder
  if (options.capture) {
    return (await proc.text()).trim()
  }
  await proc
  return undefined
}

async function fetchNodeToken() {
  const output = (await exec(
    ['k3sup', 'node-token', '--host', primaryHost, '--user', sshUser, '--ssh-key', sshKeyPath],
    { capture: true },
  )) as string | undefined
  if (!output) {
    if (dryRun) {
      return 'DRY_RUN_NODE_TOKEN'
    }
    throw new Error('k3sup node-token returned an empty response')
  }
  return output
}

function k3sVersionArgs() {
  if (k3sVersion) {
    return ['--k3s-version', k3sVersion]
  }
  return ['--k3s-channel', k3sChannel]
}

async function installPrimary() {
  console.log(`Setting up primary server ${primaryHost}`)
  await exec([
    'k3sup',
    'install',
    '--host',
    primaryHost,
    '--user',
    sshUser,
    '--cluster',
    '--local-path',
    kubeConfigPath,
    '--context',
    kubeContext,
    '--ssh-key',
    sshKeyPath,
    ...k3sVersionArgs(),
    '--k3s-extra-args',
    serverExtraArgs,
  ])
}

async function joinAdditionalServers(nodeToken: string) {
  await runParallel(additionalServers, serverParallelism, async (host, index) => {
    console.log(`Setting up additional server ${index + 2} (${host})`)
    await exec([
      'k3sup',
      'join',
      '--host',
      host,
      '--server-host',
      primaryHost,
      '--server',
      '--node-token',
      nodeToken,
      '--user',
      sshUser,
      '--ssh-key',
      sshKeyPath,
      ...k3sVersionArgs(),
      '--k3s-extra-args',
      serverExtraArgs,
    ])
  })
}

async function joinWorkers(nodeToken: string) {
  await runParallel(workerHosts, workerParallelism, async (host, index) => {
    console.log(`Setting up worker ${index + 1} (${host})`)
    await exec([
      'k3sup',
      'join',
      '--host',
      host,
      '--server-host',
      primaryHost,
      '--node-token',
      nodeToken,
      '--user',
      sshUser,
      '--ssh-key',
      sshKeyPath,
      ...k3sVersionArgs(),
      '--k3s-extra-args',
      workerExtraArgs,
    ])
  })
}

async function main() {
  await clearKnownHosts([primaryHost, ...additionalServers, ...workerHosts])
  await installPrimary()
  await waitForServerReady()
  console.log('Fetching node token from primary')
  const nodeToken = await fetchNodeToken()
  await joinAdditionalServers(nodeToken)
  await joinWorkers(nodeToken)
  console.log('Completed k3s cluster bootstrap')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

async function runParallel<T>(items: T[], concurrency: number, task: (item: T, index: number) => Promise<void>) {
  if (items.length === 0) {
    return
  }
  const limit = Math.min(concurrency, items.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const currentIndex = nextIndex
      if (currentIndex >= items.length) {
        return
      }
      nextIndex += 1
      const item = items[currentIndex]
      if (item === undefined) {
        return
      }
      await task(item, currentIndex)
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
}

async function waitForServerReady() {
  if (dryRun) {
    console.log('$ (dry-run) waiting for primary server readiness')
    return
  }
  const timeoutMs = Number.parseInt(process.env.K3S_READY_TIMEOUT_MS ?? '300000', 10)
  const pollIntervalMs = Number.parseInt(process.env.K3S_READY_POLL_MS ?? '5000', 10)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const json = await exec(['kubectl', '--kubeconfig', kubeConfigPath, 'get', 'nodes', '-o', 'json'], {
        capture: true,
        silent: true,
      })
      if (json) {
        const data = JSON.parse(json) as {
          items?: Array<{
            metadata?: { name?: string }
            status?: { conditions?: Array<{ type?: string; status?: string }> }
          }>
        }
        const nodes = data.items ?? []
        const readyNode = nodes.find((node) =>
          (node.status?.conditions ?? []).some((cond) => cond.type === 'Ready' && cond.status === 'True'),
        )
        if (readyNode) {
          console.log(`Primary control-plane reported Ready (node ${readyNode.metadata?.name ?? 'unknown'})`)
          return
        }
      }
    } catch (error) {
      console.warn('Waiting for server readiness:', error instanceof Error ? error.message : error)
    }
    await sleep(pollIntervalMs)
  }
  throw new Error(`Timed out waiting for primary server ${primaryHost} to become Ready`)
}

async function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function clearKnownHosts(hosts: string[]) {
  for (const host of new Set(hosts)) {
    console.log(`Clearing known_hosts entry for ${host}`)
    for (const target of [host, `[${host}]:22`]) {
      await exec(['ssh-keygen', '-R', target], { silent: true })
    }
  }
}
