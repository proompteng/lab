import { isIPv4 } from 'node:net'
import { z } from 'zod'

const scaleSetNameLabel = 'actions.github.com/scale-set-name'
const scaleSetNamespaceLabel = 'actions.github.com/scale-set-namespace'
const stuckAfterSeconds = 300

const count = z.number().int().nonnegative()
const resourceName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
const timestamp = z.iso.datetime({ offset: true }).transform(Date.parse)
const labels = z.record(z.string(), z.string())
const metadata = z.object({
  name: resourceName,
  namespace: resourceName,
  uid: z.string().optional(),
  labels: labels.optional(),
  creationTimestamp: timestamp.nullish(),
  deletionTimestamp: timestamp.nullish(),
})

const decimalPowers: Record<string, number> = { n: -9, u: -6, m: -3, '': 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 }

const quantity = (scale: number) =>
  z
    .string()
    .transform((value) => {
      const match = /^(\+?(?:\d+(?:\.\d*)?|\.\d+))([numkMGTPE]|[KMGTPE]i|[eE][+-]?\d+)?$/.exec(value)
      if (!match) return Number.NaN
      const [, mantissa, suffix = ''] = match
      if (suffix.endsWith('i')) return Number(mantissa) * 2 ** (('KMGTPE'.indexOf(suffix[0]) + 1) * 10) * 10 ** scale
      const exponent = decimalPowers[suffix] ?? Number(suffix.slice(1))
      return Number(`${mantissa}e${exponent + scale}`)
    })
    .pipe(z.number().min(0).max(Number.MAX_SAFE_INTEGER))

const bytes = quantity(0)
const resources = z.object({ cpu: quantity(3).optional(), memory: bytes.optional() })
const container = z.object({
  resources: z.object({ requests: resources.optional(), limits: resources.optional() }).optional(),
  restartPolicy: z.string().optional(),
})
const toleration = z.object({
  key: z.string().optional(),
  operator: z.string().optional(),
  value: z.string().optional(),
  effect: z.string().optional(),
})
const podSpec = z.object({
  nodeName: resourceName.optional(),
  nodeSelector: labels.optional(),
  tolerations: z.array(toleration).optional(),
  hostNetwork: z.boolean().optional(),
  containers: z.array(container).min(1),
  initContainers: z.array(container).optional(),
  resources: z.object({ requests: resources.optional() }).optional(),
  overhead: resources.optional(),
  volumes: z
    .array(z.object({ emptyDir: z.object({ medium: z.string().optional(), sizeLimit: bytes.optional() }).optional() }))
    .optional(),
})
const condition = z.object({
  type: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: timestamp.nullish(),
})
const podSchema = z.object({
  kind: z.literal('Pod'),
  metadata: metadata.extend({
    ownerReferences: z
      .array(z.object({ kind: z.string(), uid: z.string(), controller: z.boolean().optional() }))
      .optional(),
  }),
  spec: podSpec,
  status: z
    .object({
      phase: z.string().optional(),
      podIP: z.string().optional(),
      podIPs: z.array(z.object({ ip: z.string() })).optional(),
      conditions: z.array(condition).optional(),
    })
    .optional(),
})
const runnerSchema = z.object({
  kind: z.literal('EphemeralRunner'),
  metadata: metadata.extend({ uid: z.string().min(1) }),
  status: z
    .object({ phase: z.string().optional(), ready: z.boolean().optional(), jobId: z.string().optional() })
    .optional(),
})
const runnerSetSchema = z.object({
  kind: z.literal('AutoscalingRunnerSet'),
  metadata,
  spec: z.object({ maxRunners: count.optional(), template: z.object({ spec: podSpec }) }),
  status: z.object({ phase: z.string().optional() }).optional(),
})
const nodeSchema = z.object({
  kind: z.literal('Node'),
  metadata: metadata.omit({ namespace: true }),
  spec: z
    .object({
      unschedulable: z.boolean().optional(),
      taints: z.array(z.object({ key: z.string(), value: z.string().optional(), effect: z.string() })).optional(),
      podCIDR: z.string().optional(),
      podCIDRs: z.array(z.string()).optional(),
    })
    .optional(),
  status: z
    .object({
      allocatable: resources
        .extend({ pods: z.string().regex(/^\d+$/).transform(Number).pipe(count).optional() })
        .optional(),
      conditions: z.array(condition).optional(),
    })
    .optional(),
})
const snapshotSchema = z.object({
  observedAt: timestamp,
  runnerSets: z.unknown(),
  ephemeralRunners: z.unknown(),
  pods: z.unknown(),
  nodes: z.unknown(),
})
const listSchema = z.object({
  items: z.array(z.unknown()),
  metadata: z.object({ continue: z.string().optional() }).optional(),
})

type Pod = z.infer<typeof podSchema>
type PodSpec = z.infer<typeof podSpec>
type Runner = z.infer<typeof runnerSchema>
type Node = z.infer<typeof nodeSchema>
type Resource = keyof z.infer<typeof resources>

export class ArcAuditError extends Error {}

function parseList<T>(input: unknown, schema: z.ZodType<T>, kind: string, identity: (item: T) => string): T[] {
  const list = listSchema.safeParse(input)
  if (!list.success || list.data.metadata?.continue) throw new ArcAuditError(`expected a complete ${kind} list`)
  const seen = new Set<string>()
  return list.data.items.map((item, index) => {
    const parsed = schema.safeParse(item)
    if (!parsed.success) throw new ArcAuditError(`invalid ${kind} at item ${index + 1}`)
    const key = identity(parsed.data)
    if (seen.has(key)) throw new ArcAuditError(`duplicate ${kind} at item ${index + 1}`)
    seen.add(key)
    return parsed.data
  })
}

function namespacedName({ metadata }: { metadata: { namespace: string; name: string } }) {
  return `${metadata.namespace}/${metadata.name}`
}

function ownerUid(pod: Pod) {
  return pod.metadata.ownerReferences?.find(({ controller, kind }) => controller && kind === 'EphemeralRunner')?.uid
}

function terminalPod(pod: Pod) {
  return pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed'
}

function activeRunner(runner: Runner) {
  return (
    runner.metadata.deletionTimestamp == null &&
    !['Succeeded', 'Failed', 'Outdated'].includes(runner.status?.phase ?? '')
  )
}

function podRequest(spec: PodSpec, resource: Resource) {
  const request = (c: z.infer<typeof container>) =>
    c.resources?.requests?.[resource] ?? c.resources?.limits?.[resource] ?? 0
  let sidecars = 0
  let initPeak = 0
  for (const init of spec.initContainers ?? []) {
    const demand = request(init)
    initPeak = Math.max(initPeak, sidecars + demand)
    if (init.restartPolicy === 'Always') sidecars += demand
  }
  const steady = spec.containers.reduce((total, c) => total + request(c), sidecars)
  const effective = spec.resources?.requests?.[resource] ?? Math.max(initPeak, steady)
  return Math.ceil(effective + (spec.overhead?.[resource] ?? 0))
}

function footprint(spec: PodSpec) {
  const tmpfs = { volumes: 0, boundedBytes: 0, unboundedVolumes: 0 }
  for (const { emptyDir } of spec.volumes ?? []) {
    if (emptyDir?.medium !== 'Memory') continue
    tmpfs.volumes++
    if (emptyDir.sizeLimit) tmpfs.boundedBytes += Math.ceil(emptyDir.sizeLimit)
    else tmpfs.unboundedVolumes++
  }
  return { cpuMillis: podRequest(spec, 'cpu'), memoryBytes: podRequest(spec, 'memory'), tmpfs }
}

function usage(allocatable: number | undefined, requested: number, runners: number) {
  return {
    allocatable: allocatable ?? null,
    requested,
    runners,
    free: allocatable == null ? null : Math.max(0, allocatable - requested),
  }
}

function ipv4Number(ip: string) {
  return ip.split('.').reduce((result, octet) => result * 256 + Number(octet), 0)
}

function podCidrHeadroom(node: Node, pods: Pod[]) {
  const cidrs = node.spec?.podCIDRs?.length ? node.spec.podCIDRs : [node.spec?.podCIDR]
  // Galactic uses one IPv4 range per node. Don't claim headroom for an unsupported allocator layout.
  if (cidrs.length !== 1 || !cidrs[0]) return null
  const [ip, mask, extra] = cidrs[0].split('/')
  if (extra !== undefined || !isIPv4(ip) || !/^\d{1,2}$/.test(mask ?? '') || Number(mask) > 32) return null
  const addresses = 2 ** (32 - Number(mask))
  const start = ipv4Number(ip)
  if (start % addresses !== 0) return null
  const assigned = new Set<number>()
  let boundWithoutInRangeIp = 0
  for (const pod of pods) {
    if (pod.spec.hostNetwork) continue
    let hasIp = false
    for (const candidate of [...(pod.status?.podIPs ?? []).map(({ ip }) => ip), pod.status?.podIP]) {
      if (!candidate || !isIPv4(candidate)) continue
      const address = ipv4Number(candidate)
      if (address < start + 2 || address >= start + addresses - 1) continue
      assigned.add(address)
      hasIp = true
    }
    if (!hasIp) boundWithoutInRangeIp++
  }
  // Flannel host-local excludes the network, bridge gateway, and broadcast addresses.
  const usableIpsEstimate = Math.max(0, addresses - 3)
  return {
    cidr: cidrs[0],
    usableIpsEstimate,
    assignedIps: assigned.size,
    boundWithoutInRangeIp,
    freeIpsEstimate: Math.max(0, usableIpsEstimate - assigned.size),
  }
}

function summarizeNode(node: Node, pods: Pod[], audited: Set<string>) {
  let cpu = 0
  let memory = 0
  const runners = { pods: 0, cpuMillis: 0, memoryBytes: 0, tmpfs: { volumes: 0, boundedBytes: 0, unboundedVolumes: 0 } }
  for (const pod of pods) {
    const demand = footprint(pod.spec)
    cpu += demand.cpuMillis
    memory += demand.memoryBytes
    if (!audited.has(ownerUid(pod) ?? '')) continue
    runners.pods++
    runners.cpuMillis += demand.cpuMillis
    runners.memoryBytes += demand.memoryBytes
    runners.tmpfs.volumes += demand.tmpfs.volumes
    runners.tmpfs.boundedBytes += demand.tmpfs.boundedBytes
    runners.tmpfs.unboundedVolumes += demand.tmpfs.unboundedVolumes
  }
  const allocatable = node.status?.allocatable
  return {
    name: node.metadata.name,
    ready: node.status?.conditions?.some(({ type, status }) => type === 'Ready' && status === 'True') ?? false,
    cordoned: node.spec?.unschedulable ?? false,
    pods: usage(allocatable?.pods, pods.length, runners.pods),
    cpuMillis: usage(allocatable?.cpu, cpu, runners.cpuMillis),
    memoryBytes: usage(allocatable?.memory, memory, runners.memoryBytes),
    runnerTmpfs: runners.tmpfs,
    podCidr: podCidrHeadroom(node, pods),
  }
}

function matchesPlacement(node: Node, summary: ReturnType<typeof summarizeNode>, spec: PodSpec) {
  return (
    summary.ready &&
    !summary.cordoned &&
    (!spec.nodeName || node.metadata.name === spec.nodeName) &&
    Object.entries(spec.nodeSelector ?? {}).every(([key, value]) => node.metadata.labels?.[key] === value) &&
    (node.spec?.taints ?? []).every(({ key, effect, value }) => {
      if (effect !== 'NoSchedule' && effect !== 'NoExecute') return true
      return spec.tolerations?.some((t) => {
        if (t.effect && t.effect !== effect) return false
        if (t.operator === 'Exists') return !t.key || t.key === key
        return t.key === key && (t.value ?? '') === (value ?? '')
      })
    })
  )
}

const physicalLimits = ['node-cpu', 'node-memory', 'node-pods', 'pod-cidr'] as const
type PhysicalLimit = (typeof physicalLimits)[number]
type Bottleneck = PhysicalLimit | 'max-runners' | 'pending-scheduling' | 'pool-outdated' | 'unknown'
type Ceilings = Partial<Record<PhysicalLimit, number | null>>

function fitCeiling(ceilings: Ceilings) {
  const bounds = Object.values(ceilings)
  if (bounds.includes(0)) return 0
  if (bounds.some((bound) => bound === null)) return null
  return Math.min(...bounds.filter((bound) => bound !== null))
}

function slots(free: number | null, perPod: number) {
  return free == null ? null : Math.floor(free / perPod)
}

function nodeFit(node: ReturnType<typeof summarizeNode>, spec: PodSpec, demand: ReturnType<typeof footprint>) {
  const ceilings: Ceilings = { 'node-pods': node.pods.free }
  if (demand.cpuMillis > 0) ceilings['node-cpu'] = slots(node.cpuMillis.free, demand.cpuMillis)
  if (demand.memoryBytes > 0) ceilings['node-memory'] = slots(node.memoryBytes.free, demand.memoryBytes)
  if (!spec.hostNetwork) ceilings['pod-cidr'] = node.podCidr?.freeIpsEstimate ?? null
  return { node: node.name, ceilings, slots: fitCeiling(ceilings) }
}

function physicalHeadroom(fits: ReturnType<typeof nodeFit>[]): { slots: number | null; reason: Bottleneck } {
  if (!fits.length) return { slots: 0, reason: 'pending-scheduling' }
  let available = 0
  const gains = new Map<PhysicalLimit, number>()
  for (const { ceilings, slots } of fits) {
    if (slots == null) return { slots: null, reason: 'unknown' }
    available += slots
    for (const reason of physicalLimits) {
      if (ceilings[reason] !== slots) continue
      const relaxed = { ...ceilings }
      delete relaxed[reason]
      gains.set(reason, (gains.get(reason) ?? 0) + ((fitCeiling(relaxed) ?? slots) - slots))
    }
  }
  // Compare per-node fit before and after relaxing one constraint; spare resources are not fungible across nodes.
  const reasons = physicalLimits.filter((reason) => gains.has(reason))
  reasons.sort((a, b) => (gains.get(b) ?? 0) - (gains.get(a) ?? 0))
  return { slots: available, reason: reasons[0] ?? 'unknown' }
}

function pendingRunner(runner: Runner, pod: Pod | undefined, observedAt: number) {
  const ready = pod?.status?.conditions?.find(({ type }) => type === 'Ready')
  if (
    runner.status?.ready &&
    pod?.spec.nodeName &&
    pod.status?.phase === 'Running' &&
    (!ready || ready.status === 'True')
  )
    return null

  const scheduled = pod?.status?.conditions?.find(({ type, status }) => type === 'PodScheduled' && status === 'False')
  const stage = !pod ? 'no-pod' : !pod.spec.nodeName ? 'unscheduled' : 'starting'
  const transition =
    stage === 'unscheduled'
      ? scheduled?.lastTransitionTime
      : ready?.status !== 'True'
        ? ready?.lastTransitionTime
        : undefined
  const since = transition ?? pod?.metadata.creationTimestamp ?? runner.metadata.creationTimestamp
  const ageSeconds = since == null ? null : Math.max(0, Math.floor((observedAt - since) / 1000))
  const stuck = ageSeconds != null && ageSeconds >= stuckAfterSeconds
  const blocked =
    stage === 'unscheduled' &&
    (stuck || scheduled?.reason === 'Unschedulable' || scheduled?.reason === 'SchedulingGated')
  const schedulerLimits: PhysicalLimit[] = []
  if (blocked) {
    const message = scheduled?.message ?? ''
    if (message.includes('Insufficient cpu')) schedulerLimits.push('node-cpu')
    if (message.includes('Insufficient memory')) schedulerLimits.push('node-memory')
    if (message.includes('Too many pods')) schedulerLimits.push('node-pods')
  }
  return {
    name: runner.metadata.name,
    pod: pod?.metadata.name ?? null,
    stage,
    blocked,
    schedulerLimits,
    ageSeconds,
    stuck,
  }
}

function compareNames(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

export function auditArcRunnerPools(input: unknown) {
  const parsed = snapshotSchema.safeParse(input)
  if (!parsed.success)
    throw new ArcAuditError('expected a snapshot with an RFC3339 observedAt timestamp and four lists')
  const { observedAt } = parsed.data
  const sets = parseList(parsed.data.runnerSets, runnerSetSchema, 'AutoscalingRunnerSet', namespacedName).sort((a, b) =>
    compareNames(namespacedName(a), namespacedName(b)),
  )
  if (!sets.length) throw new ArcAuditError('no AutoscalingRunnerSets found')
  const runners = parseList(parsed.data.ephemeralRunners, runnerSchema, 'EphemeralRunner', namespacedName)
  const pods = parseList(parsed.data.pods, podSchema, 'Pod', namespacedName).filter((pod) => !terminalPod(pod))
  const nodes = parseList(parsed.data.nodes, nodeSchema, 'Node', ({ metadata }) => metadata.name).sort((a, b) =>
    compareNames(a.metadata.name, b.metadata.name),
  )

  const knownSets = new Set(sets.map(namespacedName))
  const runnersBySet = Map.groupBy(runners, ({ metadata }) => {
    const namespace = metadata.labels?.[scaleSetNamespaceLabel]
    const name = metadata.labels?.[scaleSetNameLabel]
    const key = `${namespace}/${name}`
    return namespace === metadata.namespace && name && knownSets.has(key) ? key : null
  })
  const audited = new Set(
    sets.flatMap((set) => (runnersBySet.get(namespacedName(set)) ?? []).map(({ metadata }) => metadata.uid)),
  )
  const podsByNode = Map.groupBy(pods, (pod) => pod.spec.nodeName)
  const podsByOwner = Map.groupBy(
    pods.filter(({ metadata }) => metadata.deletionTimestamp == null),
    ownerUid,
  )
  const nodeReports = nodes.map((node) => ({
    node,
    summary: summarizeNode(node, podsByNode.get(node.metadata.name) ?? [], audited),
  }))
  const runnerSets = sets.map((set) => {
    const name = namespacedName(set)
    const members = runnersBySet.get(name) ?? []
    const active = members.filter(activeRunner)
    const failed = members.filter(
      (runner) => runner.metadata.deletionTimestamp == null && runner.status?.phase === 'Failed',
    ).length
    const terminating = members.filter(({ metadata }) => metadata.deletionTimestamp != null).length
    let assigned = 0
    let readyIdle = 0
    const pending = []
    for (const runner of active.sort((a, b) => compareNames(a.metadata.name, b.metadata.name))) {
      const owned = (podsByOwner.get(runner.metadata.uid) ?? []).filter(
        ({ metadata }) => metadata.namespace === runner.metadata.namespace,
      )
      owned.sort(
        (a, b) =>
          (b.metadata.creationTimestamp ?? 0) - (a.metadata.creationTimestamp ?? 0) ||
          compareNames(a.metadata.name, b.metadata.name),
      )
      const waiting = pendingRunner(runner, owned[0], observedAt)
      const hasJob = runner.status?.phase === 'Running' || Boolean(runner.status?.jobId)
      if (hasJob) assigned++
      if (waiting) pending.push(waiting)
      else if (!hasJob) readyIdle++
    }

    const maxRunners = set.spec.maxRunners ?? null
    // ARC includes failed and deleting children when deciding whether it can create another runner.
    const capSlots = maxRunners == null ? null : Math.max(0, maxRunners - active.length - failed - terminating)
    const spec = set.spec.template.spec
    const demand = footprint(spec)
    const fits = nodeReports
      .filter(({ node, summary }) => matchesPlacement(node, summary, spec))
      .map(({ summary }) => nodeFit(summary, spec, demand))
    const physical = physicalHeadroom(fits)
    const blocked = pending.filter(({ blocked }) => blocked)
    const corroborated = blocked.some(({ schedulerLimits }) =>
      schedulerLimits.some((reason) => reason === physical.reason),
    )
    const capBinds = capSlots != null && (capSlots === 0 || (physical.slots != null && capSlots <= physical.slots))
    const estimatedAdditionalSlots = capBinds ? capSlots : physical.slots
    const bottleneck: Bottleneck =
      maxRunners === 0
        ? 'max-runners'
        : set.status?.phase === 'Outdated'
          ? 'pool-outdated'
          : blocked.length > 0
            ? physical.slots === 0 && corroborated
              ? physical.reason
              : 'pending-scheduling'
            : capBinds
              ? 'max-runners'
              : physical.reason
    return {
      name,
      maxRunners,
      active: active.length,
      utilizationPercent: maxRunners ? Math.round((active.length * 1000) / maxRunners) / 10 : null,
      failed,
      terminating,
      assigned,
      readyIdle,
      pending,
      stuck: pending.filter(({ stuck }) => stuck).length,
      schedulingBlocked: blocked.length,
      capSlots,
      runnerPod: demand,
      nodeFits: fits,
      physicalSlots: physical.slots,
      estimatedAdditionalSlots,
      bottleneck,
      saturated: estimatedAdditionalSlots === 0 || blocked.length > 0 || bottleneck === 'pool-outdated',
    }
  })
  const ranked = [...runnerSets].sort(
    (a, b) =>
      Number(b.saturated) - Number(a.saturated) ||
      b.schedulingBlocked - a.schedulingBlocked ||
      (a.estimatedAdditionalSlots ?? Infinity) - (b.estimatedAdditionalSlots ?? Infinity) ||
      b.stuck - a.stuck ||
      compareNames(a.name, b.name),
  )
  const top = ranked[0]
  return {
    observedAt: new Date(observedAt).toISOString(),
    stuckAfterSeconds,
    saturated: runnerSets.some(({ saturated }) => saturated),
    topBottleneck: { runnerSet: top.name, reason: top.bottleneck },
    unmatchedActiveRunners: (runnersBySet.get(null) ?? []).filter(activeRunner).length,
    runnerSets,
    nodes: nodeReports.map(({ summary }) => summary),
  }
}

export type ArcAuditReport = ReturnType<typeof auditArcRunnerPools>
