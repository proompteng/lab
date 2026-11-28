import { isIPv4 } from 'node:net'

import { z } from 'zod'

const galacticNodes = new Set(['turin', 'talos-192-168-1-85'])
const resourceKeys = ['cpu', 'memory', 'ephemeral-storage'] as const
const count = z.int().min(0).max(1_000_000)
const positive = count.min(1)
const bytes = z.int().nonnegative()
const percent = z.int().min(0).max(100)
const name = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[-.a-z0-9]*[a-z0-9])?$/)
const timestamp = z.iso.datetime()
const quantity = z.string().max(64)
const resources = z.object({ cpu: quantity, memory: quantity, 'ephemeral-storage': quantity.optional() })
const cpuMemory = resources.partial()
const quantities = z.object({ cpu: bytes, memory: bytes, 'ephemeral-storage': bytes })
const scope = z.object({ name, agents: z.array(name) })
const pool = z.object({ replicas: count, maxPerReplica: count, surge: count })
const concurrency = z.object({ perAgent: positive, perNamespace: positive, cluster: positive })
const rate = z.object({ perRepo: count, perNamespace: count, cluster: count, windowSeconds: positive })

const assumptionsSchema = z.object({
  workload: z.object({
    namespaces: z.array(scope).min(1),
    repository: z
      .string()
      .max(200)
      .regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/),
    requests: resources,
    p95PodWorkingSet: quantity,
    osReservePercent: percent,
    meanRunSeconds: positive,
    jobTtlSecondsAfterFinished: count,
  }),
  controller: z.object({ concurrency, rate, repoConcurrency: count }),
  cni: z.object({
    reservedIpsPerNode: count,
    extraLeases: z.array(z.object({ node: name, count })).default([]),
  }),
  database: z.object({
    maxConnections: positive,
    reservedConnections: count,
    otherConnections: count,
    safeReserveConnections: count,
    connectionsPerRun: count,
    pools: z.object({ controllers: pool, controlPlane: pool, audit: pool }),
  }),
  github: z.object({
    requestsPerHour: positive,
    otherRequestsPerHour: count,
    safeUtilizationPercent: percent.min(1),
    uncachedRequestsPerRun: positive,
    cachedRequestsPerRun: positive,
    cacheEnabled: z.boolean(),
  }),
  arc: z.object({
    scaleSet: name,
    maxRunners: count,
    otherRunnerSlots: count,
    safeUtilizationPercent: percent.min(1),
    runnerSecondsPerRun: count,
  }),
})

const exclusion = z.enum(['outside Galactic build pool', 'not Ready', 'cordoned', 'untolerated taint'])
const nodeSchema = z.object({
  name,
  architecture: z.enum(['amd64', 'arm64']),
  physicalMemoryBytes: bytes.min(1),
  allocatable: quantities,
  requested: quantities,
  workingSetBytes: bytes,
  metricsAt: timestamp,
  maxPods: positive,
  allocatablePods: count,
  podCidr: z.string(),
  pods: z.object({ active: count, activeNetworked: count, succeeded: count, failed: count, terminalIpClaims: count }),
})
const observationsSchema = z.object({
  nodes: z.array(nodeSchema),
  excluded: z.array(z.object({ name, reason: exclusion })),
  running: z.array(z.object({ namespace: name, agent: name, count: positive })),
})

const metadata = z.object({ name })
const list = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), metadata: z.object({ continue: z.literal('').optional() }).optional() })
const nodeList = list(
  z.object({
    metadata,
    spec: z.object({
      unschedulable: z.boolean().optional(),
      taints: z.array(z.object({ key: z.string(), effect: z.string() })).optional(),
      podCIDR: z.string().optional(),
      podCIDRs: z.array(z.string()).optional(),
    }),
    status: z.object({
      nodeInfo: z.object({ architecture: z.string() }),
      conditions: z.array(z.object({ type: z.string(), status: z.string() })),
      capacity: z.object({ memory: quantity, pods: quantity }),
      allocatable: resources.extend({ pods: quantity }),
    }),
  }),
)
const container = z.object({
  restartPolicy: z.string().optional(),
  resources: z.object({ requests: cpuMemory.optional() }).optional(),
})
const podList = list(
  z.object({
    spec: z.object({
      nodeName: name.or(z.literal('')).optional(),
      hostNetwork: z.boolean().optional(),
      containers: z.array(container).min(1),
      initContainers: z.array(container).optional(),
      overhead: cpuMemory.optional(),
      resources: z.object({ requests: cpuMemory.optional() }).optional(),
    }),
    status: z
      .object({
        phase: z.string().optional(),
        podIP: z.string().optional(),
        podIPs: z.array(z.object({ ip: z.string() })).optional(),
        conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
      })
      .optional(),
  }),
)
const metricsList = list(z.object({ metadata, timestamp, usage: z.object({ memory: quantity }) }))
const runList = list(
  z.object({
    metadata: z.object({ namespace: name }),
    spec: z.object({ agentRef: metadata.optional() }),
    status: z.object({ phase: z.string().optional() }).optional(),
  }),
)
const kubernetesSchema = z.object({ nodes: nodeList, pods: podList, nodeMetrics: metricsList, agentRuns: runList })

type CapacityAssumptions = z.infer<typeof assumptionsSchema>
type Observations = z.infer<typeof observationsSchema>
type Node = z.infer<typeof nodeSchema>
type Kubernetes = z.infer<typeof kubernetesSchema>
type Resources = z.infer<typeof quantities>
type Namespace = { active: number; agents: number[] }

export class CapacityInputError extends Error {}

const parse = <T>(schema: z.ZodType<T>, input: unknown, label: string): T => {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const paths = result.error.issues.slice(0, 4).map(({ path }) => path.join('.') || 'root')
  throw new CapacityInputError(`Invalid ${label} at ${paths.join(', ')}`)
}

// Sum requests in Kubernetes quantity units before rounding the effective pod request
// to millicores / bytes, as the scheduler does.
const nanos = 1_000_000_000n
const milli = 1_000_000n
const decimalPowers = new Map([
  ['n', -9],
  ['u', -6],
  ['m', -3],
  ['k', 3],
  ['M', 6],
  ['G', 9],
  ['T', 12],
  ['P', 15],
  ['E', 18],
])
const binaryPowers = ['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei']
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d
const quantityNanos = (value: string | undefined) => {
  if (value === undefined) return 0n
  const match = /^\+?(\d*)(?:\.(\d*))?(?:([eE][+-]?\d+)|([numkMGTPE]|[KMGTPE]i))?$/.exec(value)
  const [, whole, fractional = '', exponent, suffix = ''] = match ?? []
  if (!whole && !fractional) throw new CapacityInputError('Invalid Kubernetes resource quantity')
  const power = exponent ? Number(exponent.slice(1)) : (decimalPowers.get(suffix) ?? 0)
  if (!Number.isInteger(power) || Math.abs(power) > 30) {
    throw new CapacityInputError('Unsupported Kubernetes quantity exponent')
  }
  const binary = BigInt((binaryPowers.indexOf(suffix) + 1) * 10)
  const significand = BigInt(`${whole}${fractional}`) * (1n << binary)
  const scale = power + 9 - fractional.length
  return scale < 0 ? ceilDiv(significand, 10n ** BigInt(-scale)) : significand * 10n ** BigInt(scale)
}

const scalar = (value: bigint, unit: bigint) => {
  const result = Number(ceilDiv(value, unit))
  if (!Number.isSafeInteger(result)) throw new CapacityInputError('Kubernetes resource quantity exceeds safe range')
  return result
}
const units = (value: string | undefined, unit = nanos) => scalar(quantityNanos(value), unit)

const readResources = (input: z.infer<typeof cpuMemory>): Resources => ({
  cpu: units(input.cpu, milli),
  memory: units(input.memory),
  'ephemeral-storage': units(input['ephemeral-storage']),
})

const podRequest = (pod: Kubernetes['pods']['items'][number], key: (typeof resourceKeys)[number]) => {
  const { spec } = pod
  const podLevel = key !== 'ephemeral-storage' ? spec.resources?.requests?.[key] : undefined
  const overhead = quantityNanos(spec.overhead?.[key])
  const unit = key === 'cpu' ? milli : nanos
  if (podLevel !== undefined) return scalar(quantityNanos(podLevel) + overhead, unit)

  let sidecars = 0n
  let initPeak = 0n
  for (const init of spec.initContainers ?? []) {
    const request = quantityNanos(init.resources?.requests?.[key])
    if (init.restartPolicy === 'Always') sidecars += request
    const peak = sidecars + (init.restartPolicy === 'Always' ? 0n : request)
    if (peak > initPeak) initPeak = peak
  }
  const steady = spec.containers.reduce((total, c) => total + quantityNanos(c.resources?.requests?.[key]), sidecars)
  return scalar((steady > initPeak ? steady : initPeak) + overhead, unit)
}

const ipv4 = (ip: string) => ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
const cidrRange = (cidr: string) => {
  const match = /^([^/]+)\/(0|[1-9]\d?)$/.exec(cidr)
  const address = match?.[1] ?? ''
  const prefix = Number(match?.[2])
  if (!isIPv4(address) || prefix > 30) throw new CapacityInputError('Expected an IPv4 Pod CIDR with usable host IPs')
  const start = ipv4(address)
  const size = 2 ** (32 - prefix)
  if (start % size !== 0) throw new CapacityInputError('Pod CIDR is not a network address')
  return { start, end: start + size - 1, hostIps: size - 2 }
}

const uniqueBy = <T>(items: T[], key: (item: T) => string, label: string) => {
  const map = new Map(items.map((item) => [key(item), item]))
  if (map.size !== items.length) throw new CapacityInputError(`Duplicate ${label}`)
  return map
}

const normalizeKubernetes = (kube: Kubernetes): Observations => {
  const nodes: Node[] = []
  const excluded: Observations['excluded'] = []
  const metrics = uniqueBy(kube.nodeMetrics.items, (item) => item.metadata.name, 'node metrics')
  const podGroups = Map.groupBy(kube.pods.items, (pod) => pod.spec.nodeName)
  for (const {
    metadata: { name: nodeName },
    spec,
    status,
  } of kube.nodes.items) {
    const reason = !galacticNodes.has(nodeName)
      ? 'outside Galactic build pool'
      : spec.unschedulable
        ? 'cordoned'
        : !status.conditions.some(({ type, status }) => type === 'Ready' && status === 'True')
          ? 'not Ready'
          : spec.taints?.some(
                ({ key, effect }) =>
                  effect === 'NoExecute' ||
                  (effect === 'NoSchedule' && key !== 'node-role.kubernetes.io/control-plane'),
              )
            ? 'untolerated taint'
            : undefined
    if (reason) {
      excluded.push({ name: nodeName, reason })
      continue
    }

    const metric = metrics.get(nodeName)
    if (!metric) throw new CapacityInputError(`Missing node working-set metrics for ${nodeName}`)
    const podCidr = (spec.podCIDRs ?? [spec.podCIDR ?? '']).find((cidr) => isIPv4(cidr.split('/')[0] ?? ''))
    if (!podCidr) throw new CapacityInputError(`Missing IPv4 Pod CIDR for ${nodeName}`)
    const range = cidrRange(podCidr)
    const requested: Resources = { cpu: 0, memory: 0, 'ephemeral-storage': 0 }
    const pods: Node['pods'] = { active: 0, activeNetworked: 0, succeeded: 0, failed: 0, terminalIpClaims: 0 }
    const activeIps = new Set<string>()
    const terminalIps = new Set<string>()
    for (const pod of podGroups.get(nodeName) ?? []) {
      const phase = pod.status?.phase
      const terminal = phase === 'Succeeded' || phase === 'Failed'
      if (phase === 'Succeeded') pods.succeeded++
      else if (phase === 'Failed') pods.failed++
      else {
        pods.active++
        if (
          pod.status?.conditions?.some(
            ({ type, status }) => status === 'True' && (type === 'PodResizePending' || type === 'PodResizeInProgress'),
          )
        )
          throw new CapacityInputError('Pod resize in progress; recapture requests after it settles')
        for (const key of resourceKeys) requested[key] += podRequest(pod, key)
      }
      if (pod.spec.hostNetwork) continue
      if (!terminal) pods.activeNetworked++
      const ips = pod.status?.podIPs?.length ? pod.status.podIPs.map(({ ip }) => ip) : [pod.status?.podIP ?? '']
      const ipSet = terminal ? terminalIps : activeIps
      for (const ip of ips) {
        if (isIPv4(ip) && ipv4(ip) > range.start && ipv4(ip) < range.end) {
          ipSet.add(ip)
        }
      }
    }
    pods.terminalIpClaims = [...terminalIps].filter((ip) => !activeIps.has(ip)).length

    if (status.allocatable['ephemeral-storage'] === undefined) {
      throw new CapacityInputError(`Missing allocatable ephemeral storage for ${nodeName}`)
    }
    nodes.push(
      parse(
        nodeSchema,
        {
          name: nodeName,
          architecture: status.nodeInfo.architecture,
          physicalMemoryBytes: units(status.capacity.memory),
          allocatable: readResources(status.allocatable),
          requested,
          workingSetBytes: units(metric.usage.memory),
          metricsAt: metric.timestamp,
          maxPods: units(status.capacity.pods),
          allocatablePods: units(status.allocatable.pods),
          podCidr,
          pods,
        },
        'node observation',
      ),
    )
  }
  const running = new Map<string, Observations['running'][number]>()
  for (const run of kube.agentRuns.items) {
    if (run.status?.phase !== 'Running') continue
    const namespace = run.metadata.namespace
    const agent = run.spec.agentRef?.name ?? 'unknown'
    const key = `${namespace}/${agent}`
    const group = running.get(key) ?? { namespace, agent, count: 0 }
    group.count++
    running.set(key, group)
  }
  return { nodes, excluded, running: [...running.values()] }
}

export const readCapacitySnapshot = (input: unknown) => {
  const { capturedAt, assumptions, observations, kubernetes } = parse(
    z.object({
      capturedAt: timestamp,
      assumptions: assumptionsSchema,
      observations: z.unknown().optional(),
      kubernetes: z.unknown().optional(),
    }),
    input,
    'capacity snapshot',
  )
  if ((observations === undefined) === (kubernetes === undefined)) {
    throw new CapacityInputError('Supply exactly one of observations or kubernetes')
  }
  const measured =
    observations === undefined
      ? normalizeKubernetes(parse(kubernetesSchema, kubernetes, 'Kubernetes snapshot'))
      : parse(observationsSchema, observations, 'cluster observations')
  return { capturedAt, assumptions, ...measured }
}

const sum = (numbers: number[]) => numbers.reduce((total, value) => total + value, 0)
const remaining = (limit: number, used: number) => Math.max(0, limit - used)
const slots = (available: number, perRun: number) => Math.floor(available / perRun)
const utilization = (budget: number, percent: number) => Math.floor((budget * percent) / 100)

// Each run needs all local resources on the same node. Never pack by summing headroom before flooring.
const maxLocal = (parts: (number | null)[]) => Math.min(...parts.map((value) => value ?? Infinity))
const nodeCapacity = (
  node: Node,
  profile: { requests: Resources; p95Bytes: number },
  assumptions: CapacityAssumptions,
  safe: boolean,
) => {
  const { requested, allocatable, pods } = node
  const hostIps = cidrRange(node.podCidr).hostIps
  const verifiedExtraLeases = assumptions.cni.extraLeases.find((lease) => lease.node === node.name)?.count
  const ipLeases = verifiedExtraLeases ?? (safe ? pods.terminalIpClaims : 0)
  const osReserveBytes = safe
    ? scalar(BigInt(node.physicalMemoryBytes) * BigInt(assumptions.workload.osReservePercent), 100n)
    : 0
  const headroom = {
    cpuMillicores: remaining(allocatable.cpu, requested.cpu),
    memoryBytes: remaining(allocatable.memory, requested.memory),
    ephemeralStorageBytes: remaining(allocatable['ephemeral-storage'], requested['ephemeral-storage']),
    physicalBytes: remaining(node.physicalMemoryBytes, node.workingSetBytes + osReserveBytes),
    podSlots: remaining(Math.min(node.maxPods, node.allocatablePods), pods.active),
    podIps: remaining(hostIps, assumptions.cni.reservedIpsPerNode + pods.activeNetworked + ipLeases),
  }
  const limits = {
    cpuRequests: slots(headroom.cpuMillicores, profile.requests.cpu),
    memoryRequests: slots(headroom.memoryBytes, profile.requests.memory),
    ephemeralStorageRequests:
      profile.requests['ephemeral-storage'] > 0
        ? slots(headroom.ephemeralStorageBytes, profile.requests['ephemeral-storage'])
        : null,
    physicalMemory: slots(headroom.physicalBytes, profile.p95Bytes),
    maxPods: headroom.podSlots,
    podCidr: headroom.podIps,
  }
  return { headroom, limits, additional: maxLocal(Object.values(limits)), osReserveBytes, ipLeases, hostIps }
}

const rateCapacity = (perWindow: number, windowSeconds: number, runSeconds: number) =>
  perWindow === 0 ? null : slots(perWindow * runSeconds, windowSeconds)

const policyCapacity = (
  groups: Namespace[],
  running: number,
  controller: CapacityAssumptions['controller'],
  runSeconds: number,
) => {
  const { concurrency, rate, repoConcurrency } = controller
  const capacity = (rateLimit: number) => rateCapacity(rateLimit, rate.windowSeconds, runSeconds)
  const namespaceWindows = groups.map(({ active, agents }) => ({
    agent: sum(agents.map((count) => remaining(concurrency.perAgent, count))),
    namespace: remaining(concurrency.perNamespace, active),
    rate: remaining(capacity(rate.perNamespace) ?? Infinity, active),
  }))
  const perAgent = running + sum(namespaceWindows.map((group) => group.agent))
  const perNamespace = running + sum(namespaceWindows.map((group) => group.namespace))
  const namespaceRate = rate.perNamespace > 0 ? running + sum(namespaceWindows.map((group) => group.rate)) : null
  const namespacePlacement =
    running + sum(namespaceWindows.map((group) => Math.min(group.agent, group.namespace, group.rate)))
  const isolated = maxLocal([perAgent, perNamespace, namespaceRate])
  return {
    perAgent,
    perNamespace,
    clusterConcurrency: concurrency.cluster,
    repoConcurrency: repoConcurrency || null,
    namespaceRate,
    repoRate: capacity(rate.perRepo),
    clusterRate: capacity(rate.cluster),
    namespacePlacement: namespacePlacement < isolated ? namespacePlacement : null,
  }
}

const firstPassing = (low: number, high: number, passes: (value: number) => boolean) => {
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (passes(middle)) high = middle
    else low = middle + 1
  }
  return low
}

const tierPolicy = (
  groups: Namespace[],
  running: number,
  controller: CapacityAssumptions['controller'],
  duration: number,
  target: number,
) => {
  const extra = remaining(target, running)
  const fits = (ns: number, agent: number, rateCeiling = Infinity) =>
    sum(
      groups.map((group) =>
        Math.min(
          remaining(ns, group.active),
          sum(group.agents.map((active) => remaining(agent, active))),
          remaining(rateCeiling, group.active),
        ),
      ),
    ) >= extra
  const { concurrency, rate } = controller
  const perNamespace = firstPassing(concurrency.perNamespace, Math.max(concurrency.perNamespace, target), (value) =>
    fits(value, target),
  )
  const perAgent = firstPassing(concurrency.perAgent, Math.max(concurrency.perAgent, target), (value) =>
    fits(perNamespace, value),
  )
  const minRate = Math.ceil((target * rate.windowSeconds) / duration)
  const namespaceRate =
    rate.perNamespace === 0
      ? 0
      : firstPassing(rate.perNamespace, Math.max(rate.perNamespace, minRate), (value) =>
          fits(perNamespace, perAgent, rateCapacity(value, rate.windowSeconds, duration) ?? Infinity),
        )
  const adjustedRate = {
    perNamespace: namespaceRate,
    perRepo: rate.perRepo === 0 ? 0 : Math.max(rate.perRepo, minRate),
    cluster: rate.cluster === 0 ? 0 : Math.max(rate.cluster, minRate),
  }
  // The chart defaults numeric zero, whereas the runtime treats zero as disabled.
  // Don't render unchanged rate knobs (especially disabled ones).
  const rateChanges = Object.fromEntries(
    (['perNamespace', 'perRepo', 'cluster'] as const)
      .filter((key) => adjustedRate[key] > rate[key])
      .map((key) => [key, adjustedRate[key]]),
  )
  return {
    concurrency: { perNamespace, perAgent, cluster: Math.max(concurrency.cluster, target) },
    ...(Object.keys(rateChanges).length > 0 ? { rate: rateChanges } : {}),
  }
}

const poolTotals = ({ pools, ...database }: CapacityAssumptions['database']) => {
  const entries = Object.entries(pools).map(
    ([name, pool]) =>
      [
        name,
        { steady: pool.replicas * pool.maxPerReplica, peak: (pool.replicas + pool.surge) * pool.maxPerReplica },
      ] as const,
  )
  return {
    pools: Object.fromEntries(entries),
    steadyUsed: database.reservedConnections + database.otherConnections + sum(entries.map(([, pool]) => pool.steady)),
    peakUsed:
      database.reservedConnections +
      database.otherConnections +
      database.safeReserveConnections +
      sum(entries.map(([, pool]) => pool.peak)),
  }
}

const databaseLimit = (max: number, used: number, perRun: number) => {
  if (used > max) return 0
  return perRun === 0 ? null : slots(max - used, perRun)
}

const demandLimits = (assumptions: CapacityAssumptions, safe: boolean) => {
  const {
    github,
    arc,
    workload: { meanRunSeconds: duration },
  } = assumptions
  const githubBudget = utilization(
    remaining(github.requestsPerHour, github.otherRequestsPerHour),
    safe ? github.safeUtilizationPercent : 100,
  )
  const githubCold = slots(githubBudget * duration, 3600 * github.uncachedRequestsPerRun)
  const githubWarm = slots(githubBudget * duration, 3600 * github.cachedRequestsPerRun)
  const availableRunners = remaining(arc.maxRunners, arc.otherRunnerSlots)
  const usablePercent = safe ? arc.safeUtilizationPercent : 100
  const runnerToAgentRatio = arc.runnerSecondsPerRun / duration
  const arcCapacity =
    arc.runnerSecondsPerRun === 0
      ? null
      : slots(availableRunners * duration * usablePercent, 100 * arc.runnerSecondsPerRun)
  return {
    github: {
      requestsPerHour: githubBudget,
      cold: githubCold,
      warm: githubWarm,
      selected: github.cacheEnabled ? githubWarm : githubCold,
    },
    arc: { availableRunners, runnerToAgentRatio, capacity: arcCapacity },
  }
}

const tierTargets = [64, 96, 128, 160, 200]

export const measureClusterAgentCapacity = (input: unknown, target?: number) => {
  const { capturedAt, assumptions, nodes, excluded, running } = readCapacitySnapshot(input)
  if (target !== undefined) parse(positive, target, 'tier target')
  const { workload, controller, database, github, arc } = assumptions
  const namespaces = uniqueBy(workload.namespaces, (ns) => ns.name, 'controller namespace')
  for (const ns of namespaces.values()) uniqueBy(ns.agents, (agent) => agent, 'AgentRef within namespace')
  if (!workload.namespaces.some(({ agents }) => agents.length > 0)) {
    throw new CapacityInputError('Select at least one eligible AgentRef in the workload')
  }
  uniqueBy([...nodes, ...excluded], (node) => node.name, 'node')
  uniqueBy(running, ({ namespace, agent }) => `${namespace}/${agent}`, 'running AgentRun group')
  uniqueBy(assumptions.cni.extraLeases, ({ node }) => node, 'CNI lease override')
  const eligible = nodes.filter(({ name }) => galacticNodes.has(name)).sort((a, b) => a.name.localeCompare(b.name))
  const excludedNodes = [
    ...excluded,
    ...nodes
      .filter(({ name }) => !galacticNodes.has(name))
      .map(({ name }) => ({ name, reason: 'outside Galactic build pool' as const })),
    ...[...galacticNodes]
      .filter((name) => !nodes.some((node) => node.name === name) && !excluded.some((node) => node.name === name))
      .map((name) => ({ name, reason: 'missing from snapshot' as const })),
  ]
  const ranges = eligible.map((node) => cidrRange(node.podCidr)).sort((a, b) => a.start - b.start)
  if (ranges.some((range, index) => index > 0 && range.start <= (ranges[index - 1]?.end ?? 0))) {
    throw new CapacityInputError('Overlapping IPv4 Pod CIDRs on eligible nodes')
  }
  for (const node of eligible) {
    const age = Date.parse(capturedAt) - Date.parse(node.metricsAt)
    if (age < 0 || age > 120_000) throw new CapacityInputError(`Node metrics outside capture window for ${node.name}`)
    if (
      node.pods.activeNetworked > node.pods.active ||
      node.pods.terminalIpClaims > node.pods.succeeded + node.pods.failed
    ) {
      throw new CapacityInputError(`Inconsistent pod counters for ${node.name}`)
    }
  }

  const counted = running.filter(({ namespace }) => namespaces.has(namespace))
  const active = sum(counted.map(({ count }) => count))
  const groups = workload.namespaces
    .filter(({ agents }) => agents.length > 0)
    .map(({ name, agents }) => {
      const inNamespace = counted.filter(({ namespace }) => name === namespace)
      return {
        active: sum(inNamespace.map(({ count }) => count)),
        agents: agents.map((agent) => inNamespace.find((run) => run.agent === agent)?.count ?? 0),
      }
    })
  const profile = { requests: readResources(workload.requests), p95Bytes: units(workload.p95PodWorkingSet) }
  if (!profile.requests.cpu || !profile.requests.memory || !profile.p95Bytes) {
    throw new CapacityInputError('Runner CPU, memory, and P95 working set must be positive')
  }
  const policies = policyCapacity(groups, active, controller, workload.meanRunSeconds)
  const connectionBudget = poolTotals(database)
  const reportNodes = eligible.map((node) => ({
    ...node,
    theoretical: nodeCapacity(node, profile, assumptions, false),
    safe: nodeCapacity(node, profile, assumptions, true),
  }))
  const modeReport = (mode: 'theoretical' | 'safe') => {
    const safe = mode === 'safe'
    const external = demandLimits(assumptions, safe)
    const byNode = reportNodes.map((node) => node[mode])
    const nodeTotal = active + sum(byNode.map(({ additional }) => additional))
    const totals = {
      cpuRequests: active + sum(byNode.map(({ limits }) => limits.cpuRequests)),
      memoryRequests: active + sum(byNode.map(({ limits }) => limits.memoryRequests)),
      ephemeralStorageRequests:
        profile.requests['ephemeral-storage'] > 0
          ? active + sum(byNode.map(({ limits }) => limits.ephemeralStorageRequests ?? 0))
          : null,
      physicalMemory: active + sum(byNode.map(({ limits }) => limits.physicalMemory)),
      maxPods: active + sum(byNode.map(({ limits }) => limits.maxPods)),
      podCidr: active + sum(byNode.map(({ limits }) => limits.podCidr)),
    }
    const limits = {
      ...totals,
      nodePlacement: nodeTotal < maxLocal(Object.values(totals)) ? nodeTotal : null,
      ...policies,
      database: databaseLimit(
        database.maxConnections,
        safe ? connectionBudget.peakUsed : connectionBudget.steadyUsed,
        database.connectionsPerRun,
      ),
      github: external.github.selected,
      arc: external.arc.capacity,
    }
    const total = maxLocal(Object.values(limits))
    const bindings = Object.entries(limits)
      .filter(([, limit]) => limit === total)
      .map(([dimension]) => dimension)
    return {
      total,
      additional: remaining(total, active),
      binding: bindings[0],
      bindings,
      limits,
      nodeTotal,
      ...external,
    }
  }

  const theoretical = modeReport('theoretical')
  const safe = modeReport('safe')
  const targets = [...new Set([...tierTargets, ...(target !== undefined ? [target] : [])])].sort((a, b) => a - b)
  const terminalPods = sum(reportNodes.map(({ pods }) => pods.succeeded + pods.failed))
  const jobTtlSecondsAfterFinished =
    terminalPods > 0 ? Math.min(600, workload.jobTtlSecondsAfterFinished) : workload.jobTtlSecondsAfterFinished
  const tiers = targets.map((target) => {
    const policy = tierPolicy(groups, active, controller, workload.meanRunSeconds, target)
    const blockers = Object.entries(safe.limits)
      .filter(([, limit]) => limit !== null && limit < target)
      .sort(([, a], [, b]) => (a ?? Infinity) - (b ?? Infinity))
      .map(([dimension]) => dimension)
    const recommendCache =
      workload.repository === 'proompteng/lab' &&
      !github.cacheEnabled &&
      safe.github.cold < target &&
      safe.github.warm > safe.github.cold
    const requiredMaxConnections = connectionBudget.peakUsed + target * database.connectionsPerRun
    const requiredArcRunners =
      arc.runnerSecondsPerRun === 0
        ? 0
        : arc.otherRunnerSlots +
          Math.ceil((target * arc.runnerSecondsPerRun * 100) / (workload.meanRunSeconds * arc.safeUtilizationPercent))
    // Each request ceiling is a one-knob counterfactual, not a safe lower request or a combined patch.
    const withOtherNodeInputsFixed = (current: number, capacityAt: (candidate: number) => number) =>
      current > 0 && safe.nodeTotal < target && capacityAt(1) >= target
        ? firstPassing(1, current, (candidate) => capacityAt(candidate) < target) - 1
        : null
    const placement = (candidate: typeof profile) =>
      active + sum(eligible.map((node) => nodeCapacity(node, candidate, assumptions, true).additional))
    const conditionalRequestKnobs = resourceKeys.flatMap((key) => {
      const limit = withOtherNodeInputsFixed(profile.requests[key], (candidate) =>
        placement({ ...profile, requests: { ...profile.requests, [key]: candidate } }),
      )
      if (limit === null) return []
      return [
        {
          key: `controller.defaultWorkload.resources.requests.${key}`,
          maximum: key === 'cpu' ? `${limit}m` : String(limit),
        },
      ]
    })
    const p95WorkingSetCeilingBytes = withOtherNodeInputsFixed(profile.p95Bytes, (p95Bytes) =>
      placement({ ...profile, p95Bytes }),
    )

    return {
      target,
      additionalNeeded: remaining(target, active),
      reachable: safe.total >= target,
      blockers,
      maxGithubRequestsPerRun: slots(safe.github.requestsPerHour * workload.meanRunSeconds, 3600 * target),
      valuesYaml: {
        controller: {
          ...policy,
          jobTtlSecondsAfterFinished,
        },
        ...(recommendCache
          ? {
              controllers: {
                env: { vars: { AGENTS_AGENT_RUNNER_SHARED_CACHE_HOST_PATH: '/var/lib/agents-workspace-cache' } },
              },
            }
          : {}),
      },
      // CNPG and ARC are separate owners, not keys in Agents values.yaml.
      requiredMaxConnections,
      requiredRepoConcurrency: controller.repoConcurrency > 0 ? target : null,
      arc: { scaleSet: arc.scaleSet, minMaxRunners: requiredArcRunners },
      conditionalRequestKnobs,
      p95WorkingSetCeilingBytes,
    }
  })
  return {
    capturedAt,
    workload,
    p95PodWorkingSetBytes: profile.p95Bytes,
    controller,
    database: { ...database, ...connectionBudget },
    githubCacheEnabled: github.cacheEnabled,
    running: active,
    nodes: reportNodes,
    excludedNodes,
    theoretical,
    safe,
    tiers,
    nextTier: target ?? tiers.find((tier) => !tier.reachable)?.target ?? null,
  }
}
