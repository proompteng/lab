import {
  type Stats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  type Cbr0Node,
  type Lease,
  asObject,
  cbr0Range,
  classifyLease,
  isCbr0Node,
  isUsableLeaseIP,
  podIPsFromList,
  taskIDsFromList,
} from './cni-cbr0-lease-audit-core'

type Options = { node: Cbr0Node; context: string; hostRoot: string; mode: 'dry-run' | 'archive' }
type LeaseSnapshot = Lease & { stat?: Stats }
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const maxLeaseBytes = 128

const usage = `Usage: bun run packages/scripts/src/galactic/cni-cbr0-lease-audit.ts
  --context <kubectl-context> --node <turin|talos-192-168-1-85>
  [--host-root <absolute-path>] [--mode <dry-run|archive>]

Run on the target Linux node or from its authorized host-PID maintenance session.
The host root defaults to /. Archive requires a cordoned node.`

function parseOptions(args: string[]): Options | undefined {
  const { values } = parseArgs({
    args,
    options: {
      context: { type: 'string' },
      node: { type: 'string' },
      'host-root': { type: 'string', default: '/' },
      mode: { type: 'string', default: 'dry-run' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) return
  const { context, node, 'host-root': hostRoot, mode } = values
  if (!context || !node || !isCbr0Node(node) || !isAbsolute(hostRoot) || (mode !== 'dry-run' && mode !== 'archive')) {
    throw new Error(usage)
  }
  return { context, node, hostRoot, mode }
}

function capture(description: string, command: string[]): string {
  const result = Bun.spawnSync(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 10_000 })
  if (!result.success) throw new Error(`${description} failed (${result.signalCode ?? `exit ${result.exitCode}`})`)
  return result.stdout.toString()
}

function jsonOutput(output: string, description: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`Invalid JSON from ${description}`)
  }
}

function verifyNode(value: unknown, { node, mode, hostRoot }: Options, cidr: string) {
  const object = asObject(value, 'Node')
  const spec = asObject(object.spec, 'Node spec')
  const status = asObject(object.status, 'Node status')
  const bootID = readFileSync(join(hostRoot, 'proc/sys/kernel/random/boot_id'), 'utf8').trim()
  if (
    object.apiVersion !== 'v1' ||
    object.kind !== 'Node' ||
    asObject(object.metadata, 'Node metadata').name !== node ||
    asObject(status.nodeInfo, 'Node info').bootID !== bootID ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootID)
  ) {
    throw new Error('The Kubernetes Node does not match this host boot ID')
  }
  if (
    spec.podCIDR !== cidr ||
    !Array.isArray(spec.podCIDRs) ||
    spec.podCIDRs.length !== 1 ||
    spec.podCIDRs[0] !== cidr
  ) {
    throw new Error(`Expected ${node} to have the single PodCIDR ${cidr}`)
  }
  if (mode === 'archive' && spec.unschedulable !== true) throw new Error(`Cordon ${node} before archiving leases`)
}

const sameFile = (before: Stats, after: Stats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.ctimeMs === after.ctimeMs &&
  before.mtimeMs === after.mtimeMs &&
  before.size === after.size &&
  before.nlink === after.nlink

function readLease(directory: string, name: string, range: ReturnType<typeof cbr0Range>): LeaseSnapshot {
  if (!isUsableLeaseIP(name, range)) return { name }
  const path = join(directory, name)
  const stat = lstatSync(path)
  // Never open links, special files or unexpectedly large files.
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxLeaseBytes) return { name }
  const fd = openSync(path, readFlags)
  try {
    if (!sameFile(stat, fstatSync(fd))) throw new Error(`Lease changed while opening: ${name}`)
    const buffer = Buffer.alloc(maxLeaseBytes + 1)
    const bytes = readSync(fd, buffer)
    if (bytes !== stat.size || !sameFile(stat, fstatSync(fd))) throw new Error(`Lease changed while reading: ${name}`)
    return { name, stat, file: { contents: buffer.toString('utf8', 0, bytes), mtimeMs: stat.mtimeMs } }
  } finally {
    closeSync(fd)
  }
}

function audit(options: Options) {
  if (process.platform !== 'linux') throw new Error('The cbr0 lease audit must run on Linux')
  const { node, context, hostRoot, mode } = options
  const range = cbr0Range(node)
  const kubectl = (description: string, path: string) =>
    jsonOutput(
      capture(description, ['kubectl', '--context', context, '--request-timeout=8s', 'get', '--raw', path]),
      description,
    )
  verifyNode(kubectl('Kubernetes Node lookup', `/api/v1/nodes/${node}`), options, range.cidr)

  const cni = join(hostRoot, 'var/lib/cni')
  const networks = join(cni, 'networks')
  const directory = join(networks, 'cbr0')
  for (const path of [cni, networks, directory]) {
    if (!lstatSync(path).isDirectory()) throw new Error(`Expected a real directory: ${path}`)
  }

  const fd = openSync(join(directory, 'lock'), readFlags)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Invalid cbr0 allocator lock')
    // flock(2) locks the open file description shared with fd 3; closing our fd releases it.
    const lock = Bun.spawnSync(['flock', mode === 'archive' ? '-xn' : '-sn', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      timeout: 1_000,
    })
    if (!lock.success) throw new Error('Cannot acquire the cbr0 allocator lock; retry from a fresh audit')

    const nowMs = Date.now()
    const leases = readdirSync(directory)
      .sort()
      .map((name) => readLease(directory, name, range))
    const podIPs = podIPsFromList(
      kubectl('Kubernetes PodList', `/api/v1/pods?fieldSelector=${encodeURIComponent(`spec.nodeName=${node}`)}`),
      node,
    )
    const taskIDs = taskIDsFromList(
      capture('containerd task list', [
        'ctr',
        '--address',
        join(hostRoot, 'run/containerd/containerd.sock'),
        '--namespace',
        'k8s.io',
        '--timeout',
        '8s',
        'tasks',
        'list',
        '--quiet',
      ]),
    )
    const evidence = { range, nowMs, podIPs, taskIDs }
    const results = leases.map((lease) => classifyLease(lease, evidence))
    const candidates = results.filter((result) => result.status === 'orphan').map(({ name }) => name)
    const archived: string[] = []
    let archiveDir: string | undefined
    if (mode === 'archive' && candidates.length > 0) {
      const snapshots = new Map(leases.map((lease) => [lease.name, lease.stat]))
      archiveDir = mkdtempSync(join(cni, `cbr0-archive-${node}-`))
      console.error(`Archiving eligible leases to ${archiveDir}`)
      for (const name of candidates) {
        const path = join(directory, name)
        const snapshot = snapshots.get(name)
        if (!snapshot || !sameFile(snapshot, lstatSync(path)))
          throw new Error(`Lease changed before archiving: ${name}`)
        // The private, new sibling directory keeps the original bytes/metadata and avoids name collisions.
        renameSync(path, join(archiveDir, name))
        archived.push(name)
      }
    }
    return { node, mode, podCIDR: range.cidr, capacity: range.capacity, archiveDir, archived, results }
  } finally {
    closeSync(fd)
  }
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2))
    console.log(options ? JSON.stringify(audit(options), null, 2) : usage)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Lease audit failed')
    process.exitCode = 1
  }
}
