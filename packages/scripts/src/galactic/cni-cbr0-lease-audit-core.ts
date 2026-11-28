import { isIP, isIPv4 } from 'node:net'

const podCidrs = {
  turin: '10.244.0.0/23',
  'talos-192-168-1-85': '10.244.4.0/23',
} as const

export type Cbr0Node = keyof typeof podCidrs
export const isCbr0Node = (name: string): name is Cbr0Node => Object.hasOwn(podCidrs, name)
export const minimumLeaseAgeSeconds = 300

const ipv4Number = (address: string) => address.split('.').reduce((number, octet) => number * 256 + Number(octet), 0)

export const cbr0Range = (node: Cbr0Node) => {
  const cidr = podCidrs[node]
  const slash = cidr.indexOf('/')
  const network = ipv4Number(cidr.slice(0, slash))
  // host-local excludes the network/broadcast, and Flannel uses the first host address as gateway.
  const capacity = 2 ** (32 - Number(cidr.slice(slash + 1))) - 3
  return { cidr, capacity, first: network + 2, last: network + capacity + 1 }
}

export const isUsableLeaseIP = (name: string, range: ReturnType<typeof cbr0Range>) => {
  if (!isIPv4(name)) return false
  const address = ipv4Number(name)
  return address >= range.first && address <= range.last
}

const ownerPattern = /^[0-9a-f]{64}(?:\r?\n[a-zA-Z0-9_.:-]{1,15})?(?:\r?\n)?$/
const leaseOwner = (contents: string) => (ownerPattern.test(contents) ? contents.slice(0, 64) : undefined)

export type Lease = {
  name: string
  file?: { contents: string; mtimeMs: number }
}

type Inspection = {
  range: ReturnType<typeof cbr0Range>
  podIPs: ReadonlySet<string>
  taskIDs: ReadonlySet<string>
  nowMs: number
}

export const classifyLease = ({ name, file }: Lease, { range, podIPs, taskIDs, nowMs }: Inspection) => {
  if (name === 'lock' || /^last_reserved_ip\.\d+$/.test(name)) return { name, status: 'allocator-metadata' } as const
  if (!isIP(name)) return { name, status: 'unexpected-name' } as const
  if (!isUsableLeaseIP(name, range)) return { name, status: 'outside-usable-range' } as const
  if (!file) return { name, status: 'unsafe-file' } as const
  const owner = leaseOwner(file.contents)
  const ageMs = nowMs - file.mtimeMs
  if (!owner || !Number.isFinite(ageMs)) return { name, status: 'invalid-lease' } as const

  const ageSeconds = Math.floor(ageMs / 1000)
  if (podIPs.has(name)) return { name, status: 'pod-ip', ageSeconds } as const
  if (taskIDs.has(owner)) return { name, status: 'containerd-task', ageSeconds } as const
  if (ageMs < minimumLeaseAgeSeconds * 1000) return { name, status: 'too-young', ageSeconds } as const
  return { name, status: 'orphan', ageSeconds } as const
}

export const asObject = (value: unknown, description: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${description}`)
  return value as Record<string, unknown>
}

export const podIPsFromList = (value: unknown, node: Cbr0Node) => {
  const list = asObject(value, 'PodList')
  const metadata = asObject(list.metadata, 'PodList metadata')
  if (
    list.apiVersion !== 'v1' ||
    list.kind !== 'PodList' ||
    !Array.isArray(list.items) ||
    typeof metadata.resourceVersion !== 'string' ||
    !metadata.resourceVersion ||
    (metadata.continue !== undefined && metadata.continue !== '')
  ) {
    throw new Error('Expected a complete core/v1 PodList')
  }

  const ips = new Set<string>()
  const addIP = (ip: unknown) => {
    if (typeof ip !== 'string' || !isIP(ip)) throw new Error('Invalid IP in PodList')
    ips.add(ip)
  }
  for (const item of list.items) {
    const pod = asObject(item, 'PodList item')
    if (asObject(pod.spec, 'Pod spec').nodeName !== node) throw new Error('PodList contains a Pod on the wrong node')
    if (pod.status === undefined) continue
    const status = asObject(pod.status, 'Pod status')
    // Keep every published address, including terminal and terminating Pods.
    if (status.podIP !== undefined && status.podIP !== '') addIP(status.podIP)
    if (status.podIPs === undefined) continue
    if (!Array.isArray(status.podIPs)) throw new Error('Invalid Pod status.podIPs')
    for (const entry of status.podIPs) addIP(asObject(entry, 'Pod IP entry').ip)
  }
  return ips
}

export const taskIDsFromList = (output: string) => {
  const ids = output === '' ? [] : output.replace(/\n$/, '').split('\n')
  if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id))) {
    throw new Error('Expected one containerd task ID per line from ctr tasks list --quiet')
  }
  return new Set(ids)
}
