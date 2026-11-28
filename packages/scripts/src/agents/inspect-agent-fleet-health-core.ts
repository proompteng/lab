import { isIPv4 } from 'node:net'
import { z } from 'zod'

const RUN_LABEL = 'agents.proompteng.ai/agent-run'
const RUN_UID_LABEL = 'agents.proompteng.ai/run-uid'
const RUNNER_ACCOUNT = 'codex-auto-ontology-runner'
const MCP_AUDIENCE = 'agents.proompteng.ai/auto-ontology-mcp'
const MCP_MOUNT_PATH = '/var/run/secrets/agents-auto-ontology-mcp'
const FLEET_NODES = ['turin', 'talos-192-168-1-85'] as const
const ADMISSION_SECONDS = 180
const SKEW_PERCENT = 85
const PEER_FREE_IPS = 100
const MEMORY_PERCENT = 80

// Parse only the fields we need; never pass raw workload specs or diagnostics to the report.
const name = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
const timestamp = z.iso.datetime({ offset: true })
const condition = z.object({ type: z.string(), status: z.string(), reason: z.string().optional() })
const metadata = z.object({
  name,
  namespace: name,
  uid: z.string().optional(),
  deletionTimestamp: timestamp.nullish(),
  labels: z.object({ [RUN_LABEL]: z.string().optional(), [RUN_UID_LABEL]: z.string().optional() }).optional(),
  ownerReferences: z.array(z.object({ apiVersion: z.string(), kind: z.string(), name, uid: z.string() })).default([]),
})
const list = <Schema extends z.ZodType>(item: Schema) => z.object({ items: z.array(item) })
const agentRun = z.object({
  metadata: metadata.extend({ creationTimestamp: timestamp }),
  spec: z.object({ runtime: z.object({ type: z.string().optional() }).optional() }).optional(),
  status: z
    .object({
      phase: z.string().nullish(),
      conditions: z.array(condition).default([]),
      runtimeRef: z
        .object({
          type: z.string().optional(),
          name: z.string().optional(),
          namespace: name.optional(),
          uid: z.string().optional(),
        })
        .nullish(),
    })
    .nullish(),
})
const job = z.object({
  metadata,
  status: z
    .object({
      active: z.int().nonnegative().optional(),
      ready: z.int().nonnegative().optional(),
      succeeded: z.int().nonnegative().optional(),
      conditions: z.array(condition).default([]),
    })
    .optional(),
})
const pod = z.object({
  metadata,
  spec: z.object({
    nodeName: name.optional(),
    hostNetwork: z.boolean().optional(),
    serviceAccountName: name.optional(),
    containers: z.array(
      z.object({
        name,
        resources: z.object({ limits: z.object({ memory: z.string().optional() }).optional() }).optional(),
        volumeMounts: z
          .array(
            z.object({
              name,
              mountPath: z.string(),
              subPath: z.string().optional(),
              subPathExpr: z.string().optional(),
            }),
          )
          .default([]),
      }),
    ),
    volumes: z
      .array(
        z.object({
          name,
          projected: z
            .object({
              sources: z.array(
                z.object({
                  serviceAccountToken: z.object({ audience: z.string().optional(), path: z.string() }).optional(),
                }),
              ),
            })
            .optional(),
        }),
      )
      .default([]),
  }),
  status: z
    .object({
      phase: z.string().optional(),
      podIP: z.string().optional(),
      podIPs: z.array(z.object({ ip: z.string() })).default([]),
    })
    .optional(),
})
const node = z.object({
  metadata: z.object({ name, labels: z.object({ 'kubernetes.io/arch': z.string().optional() }).optional() }),
  spec: z
    .object({
      podCIDR: z.string().optional(),
      unschedulable: z.boolean().optional(),
      taints: z.array(z.object({ key: z.string(), effect: z.string() })).default([]),
    })
    .optional(),
  status: z
    .object({
      conditions: z.array(condition).default([]),
      nodeInfo: z.object({ architecture: z.string() }).optional(),
    })
    .optional(),
})

export const fleetSnapshot = z.object({
  capturedAt: timestamp,
  agentRuns: list(agentRun),
  jobs: list(job),
  pods: list(pod),
  nodes: list(node),
  podMetrics: list(
    z.object({
      metadata: z.object({ namespace: name, name }),
      containers: z.array(z.object({ name, usage: z.object({ memory: z.string().optional() }) })),
    }),
  ).nullish(),
})

type Snapshot = z.infer<typeof fleetSnapshot>
type Metadata = z.infer<typeof metadata>
type Pod = z.infer<typeof pod>
type Job = z.infer<typeof job>
type Node = z.infer<typeof node>
type RunLink = { key: string; uid?: string }

const severity = {
  phase_pod_desync: 'critical',
  stuck_admission: 'critical',
  workload_identity: 'critical',
  mcp_projection: 'critical',
  node_skew: 'warning',
  memory_pressure: 'warning',
  memory_check_incomplete: 'warning',
} as const
type AnomalyCode = keyof typeof severity
type Anomaly = { code: AnomalyCode; severity: (typeof severity)[AnomalyCode]; subject: string; message: string }

const resourceKey = ({ namespace, name }: Pick<Metadata, 'namespace' | 'name'>) => `${namespace}/${name}`
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const byResource = <T extends { metadata: Pick<Metadata, 'namespace' | 'name'> }>(left: T, right: T) =>
  compare(resourceKey(left.metadata), resourceKey(right.metadata))

const runLink = (resource: Metadata): RunLink | undefined => {
  const owner = resource.ownerReferences.find(
    ({ kind, apiVersion }) => kind === 'AgentRun' && apiVersion.startsWith('agents.proompteng.ai/'),
  )
  const name = owner?.name ?? resource.labels?.[RUN_LABEL]
  if (!name) return undefined
  return {
    key: resourceKey({ namespace: resource.namespace, name }),
    uid: owner?.uid ?? resource.labels?.[RUN_UID_LABEL],
  }
}

const indexWorkloads = ({ agentRuns, jobs, pods }: Snapshot) => {
  const workloads = new Map(
    agentRuns.items.map(({ metadata }) => [
      resourceKey(metadata),
      { uid: metadata.uid, jobs: [] as Job[], pods: [] as Pod[] },
    ]),
  )
  const references = new Map<string, { jobUid?: string; run: RunLink }[]>()
  for (const { metadata, status } of agentRuns.items) {
    const ref = status?.runtimeRef
    if (!ref?.name || (ref.type !== 'job' && ref.type !== 'workflow')) continue
    const key = resourceKey({ namespace: ref.namespace ?? metadata.namespace, name: ref.name })
    const candidates = references.get(key) ?? []
    candidates.push({ jobUid: ref.uid, run: { key: resourceKey(metadata), uid: metadata.uid } })
    references.set(key, candidates)
  }
  const referencedRun = (key: string, jobUid: string | undefined) => {
    const matches = references.get(key)?.filter((ref) => !ref.jobUid || ref.jobUid === jobUid)
    return matches?.length === 1 ? matches[0]?.run : undefined
  }
  const currentRun = (link: RunLink) => {
    const run = workloads.get(link.key)
    return run && (!link.uid || link.uid === run.uid) ? run : undefined
  }

  const jobLinks = new Map<string, { uid?: string; run: RunLink | undefined }>()
  for (const job of jobs.items.toSorted(byResource)) {
    const key = resourceKey(job.metadata)
    const run = runLink(job.metadata) ?? referencedRun(key, job.metadata.uid)
    jobLinks.set(key, { uid: job.metadata.uid, run })
    if (run) currentRun(run)?.jobs.push(job)
  }

  const fleetPods = pods.items.toSorted(byResource).filter((pod) => {
    const owner = pod.metadata.ownerReferences.find(
      ({ kind, apiVersion }) => kind === 'Job' && apiVersion === 'batch/v1',
    )
    let fromJob: RunLink | undefined
    if (owner) {
      const key = resourceKey({ namespace: pod.metadata.namespace, name: owner.name })
      const job = jobLinks.get(key)
      // A Pod from a deleted Job must not inherit the identity of a same-name replacement.
      fromJob = job ? (job.uid === owner.uid ? job.run : undefined) : referencedRun(key, owner.uid)
    }
    const run = fromJob ?? runLink(pod.metadata)
    if (!run) return false
    currentRun(run)?.pods.push(pod)
    return true
  })
  return { workloads, fleetPods }
}

const hasCondition = (conditions: z.infer<typeof condition>[] | undefined, type: string, reason?: string) =>
  conditions?.some(
    (condition) => condition.type === type && condition.status === 'True' && (!reason || condition.reason === reason),
  ) ?? false

const terminalPhase = (pod: Pod) => {
  const phase = pod.status?.phase
  return phase === 'Succeeded' || phase === 'Failed' ? phase : null
}
const activePod = (pod: Pod) =>
  !pod.metadata.deletionTimestamp && (pod.status?.phase === 'Pending' || pod.status?.phase === 'Running')

const jobPhase = (job: Job) => {
  if (hasCondition(job.status?.conditions, 'Failed')) return 'Failed'
  if (hasCondition(job.status?.conditions, 'Complete') || (job.status?.succeeded ?? 0) > 0) return 'Succeeded'
  // Job status.active also counts Pending Pods; it is not proof of execution.
  if ((job.status?.ready ?? 0) > 0 && !job.metadata.deletionTimestamp) return 'Running'
  return null
}

const hasMcpMount = (pod: Pod) => {
  const runner = pod.spec.containers.find(({ name }) => name === 'agent-runner')
  return runner?.volumeMounts.some(
    (mount) =>
      mount.mountPath === MCP_MOUNT_PATH &&
      !mount.subPath &&
      !mount.subPathExpr &&
      pod.spec.volumes.some(
        (volume) =>
          volume.name === mount.name &&
          volume.projected?.sources.some(
            ({ serviceAccountToken }) =>
              serviceAccountToken?.audience === MCP_AUDIENCE && serviceAccountToken.path === 'token',
          ),
      ),
  )
}

const ipv4Number = (ip: string) =>
  isIPv4(ip) ? ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0) : null

const podAddresses = (pod: Pod) =>
  pod.spec.hostNetwork
    ? []
    : [pod.status?.podIP ?? '', ...(pod.status?.podIPs.map(({ ip }) => ip) ?? [])]
        .map(ipv4Number)
        .filter((ip) => ip !== null)

const freePodIPs = (cidr: string | undefined, pods: Pod[], nodeName: string) => {
  const [ip, mask] = /^([\d.]+)\/(\d{1,2})$/.exec(cidr ?? '')?.slice(1) ?? []
  const base = ipv4Number(ip ?? '')
  const prefix = Number(mask)
  if (base === null || !(prefix >= 0 && prefix <= 30)) return null
  const size = 2 ** (32 - prefix)
  if (base % size !== 0) return null
  // Galactic reserves network, gateway and broadcast. Deduplicate reused addresses,
  // but count terminal-only claims conservatively; API status is not an IPAM lease ledger.
  const addresses = new Set<number>()
  for (const pod of pods) {
    if (pod.spec.nodeName !== nodeName) continue
    for (const address of podAddresses(pod)) {
      if (address > base + 1 && address < base + size - 1) addresses.add(address)
    }
  }
  return size - 3 - addresses.size
}

const schedulable = (node: Node | undefined) =>
  hasCondition(node?.status?.conditions, 'Ready') &&
  !node?.spec?.unschedulable &&
  !node?.spec?.taints.some(
    ({ key, effect }) =>
      effect === 'NoExecute' || (effect === 'NoSchedule' && key !== 'node-role.kubernetes.io/control-plane'),
  )

const decimalPowers = { n: -9, u: -6, m: -3, '': 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 } as const
const memoryBytes = (value: string | undefined) => {
  const match = /^(\+?(?:\d+(?:\.\d*)?|\.\d+))([KMGTPE]i|[numkMGTPE]|[eE][+-]?\d+)?$/.exec(value ?? '')
  if (!match) return null
  const [, amount, suffix = ''] = match
  const factor = suffix.endsWith('i')
    ? 1024 ** ('KMGTPE'.indexOf(suffix.charAt(0)) + 1)
    : 10 ** (suffix.length > 1 ? Number(suffix.slice(1)) : decimalPowers[suffix as keyof typeof decimalPowers])
  const bytes = Number(amount) * factor
  // Kubernetes quantities are bounded to int64 magnitude. Reject out-of-range fixture values.
  return bytes >= 0 && bytes <= 2 ** 63 ? bytes : null
}

const percent = (numerator: number, denominator: number) => Number(((numerator / denominator) * 100).toFixed(2))

export const inspectAgentFleetHealth = (snapshot: Snapshot) => {
  const { workloads, fleetPods } = indexWorkloads(snapshot)
  const anomalies: Anomaly[] = []
  const add = (code: AnomalyCode, subject: string, message: string) => {
    anomalies.push({ code, severity: severity[code], subject, message })
  }

  for (const { metadata, spec, status } of snapshot.agentRuns.items) {
    const phase = status?.phase || null
    if (metadata.deletionTimestamp || (phase !== null && phase !== 'Pending')) continue
    const runtime = status?.runtimeRef?.type ?? spec?.runtime?.type
    if (runtime === 'custom' || runtime === 'temporal') continue

    const key = resourceKey(metadata)
    const related = workloads.get(key)
    const pod = related?.pods.find((pod) => (activePod(pod) && pod.status?.phase === 'Running') || terminalPhase(pod))
    const job = related?.jobs.find((job) => jobPhase(job) !== null)
    const progress = pod
      ? `Pod ${resourceKey(pod.metadata)} is ${pod.status?.phase}`
      : job
        ? `Job ${resourceKey(job.metadata)} is ${jobPhase(job)}`
        : null
    const rateLimit = hasCondition(status?.conditions, 'Blocked', 'RateLimit') ? ' (Blocked:RateLimit)' : ''
    if (progress) {
      add('phase_pod_desync', key, `AgentRun phase is ${phase}${rateLimit}, but ${progress}.`)
      continue
    }

    const ageSeconds = (Date.parse(snapshot.capturedAt) - Date.parse(metadata.creationTimestamp)) / 1000
    const activeJob = related?.jobs.some((job) => !job.metadata.deletionTimestamp && (job.status?.active ?? 0) > 0)
    if (ageSeconds > ADMISSION_SECONDS && !activeJob && !related?.pods.some(activePod)) {
      add(
        'stuck_admission',
        key,
        `AgentRun phase is ${phase}${rateLimit} at age ${ageSeconds}s without an active Job or Pod.`,
      )
    }
  }

  const activePods = fleetPods.filter(activePod)
  const scheduledPods = activePods.filter((pod) => pod.spec.nodeName)
  const nodes = FLEET_NODES.map((name) => {
    const node = snapshot.nodes.items.find(({ metadata }) => metadata.name === name)
    const architecture = node?.status?.nodeInfo?.architecture ?? node?.metadata.labels?.['kubernetes.io/arch']
    const activePods = scheduledPods.filter((pod) => pod.spec.nodeName === name).length
    return {
      name,
      architecture: architecture === 'amd64' || architecture === 'arm64' ? architecture : null,
      schedulable: schedulable(node),
      activePods,
      scheduledSharePercent: scheduledPods.length ? percent(activePods, scheduledPods.length) : 0,
      freePodIPs: freePodIPs(node?.spec?.podCIDR, snapshot.pods.items, name),
    }
  })
  for (const node of nodes) {
    const peer = nodes.find((candidate) => candidate.name !== node.name)
    if (
      node.schedulable &&
      peer?.schedulable &&
      peer.freePodIPs !== null &&
      peer.freePodIPs > PEER_FREE_IPS &&
      node.activePods * 100 > scheduledPods.length * SKEW_PERCENT
    ) {
      add(
        'node_skew',
        node.name,
        `${node.scheduledSharePercent}% of scheduled active Pods are here; ${peer.name} has ${peer.freePodIPs} estimated free pod IPs.`,
      )
    }
  }

  const metrics = new Map(snapshot.podMetrics?.items.map((item) => [resourceKey(item.metadata), item.containers]))
  let runningPods = 0
  let memoryCheckedPods = 0
  for (const pod of activePods) {
    const key = resourceKey(pod.metadata)
    if (pod.spec.serviceAccountName !== RUNNER_ACCOUNT) {
      const account = pod.spec.serviceAccountName ?? 'default'
      const observed = account === 'default' || account === 'agents-sa' ? account : 'another account'
      add('workload_identity', key, `Pod uses ${observed}; expected ${RUNNER_ACCOUNT}.`)
    }
    if (!hasMcpMount(pod))
      add('mcp_projection', key, 'agent-runner is missing the mounted Auto Ontology MCP token projection.')

    if (pod.status?.phase !== 'Running') continue
    runningPods++
    const usage = metrics.get(key)
    let complete = pod.spec.containers.length > 0
    for (const container of pod.spec.containers) {
      const limit = memoryBytes(container.resources?.limits?.memory)
      const used = memoryBytes(usage?.find(({ name }) => name === container.name)?.usage.memory)
      if (!limit || used === null) {
        complete = false
        continue
      }
      if (used * 100 > limit * MEMORY_PERCENT) {
        add(
          'memory_pressure',
          key,
          `Container ${container.name} is at ${percent(used, limit)}% of its memory limit (${used} / ${limit} bytes).`,
        )
      }
    }
    if (complete) memoryCheckedPods++
  }
  if (memoryCheckedPods < runningPods) {
    add(
      'memory_check_incomplete',
      'fleet',
      `Memory coverage is ${memoryCheckedPods}/${runningPods} running Pods; some limits or usage samples are unavailable.`,
    )
  }

  const terminalByNamespace = new Map<
    string,
    { namespace: string; succeeded: number; failed: number; withPodIP: number }
  >()
  let terminalPods = 0
  for (const pod of fleetPods) {
    const phase = terminalPhase(pod)
    if (!phase) continue
    const { namespace } = pod.metadata
    const count = terminalByNamespace.get(namespace) ?? { namespace, succeeded: 0, failed: 0, withPodIP: 0 }
    if (phase === 'Succeeded') count.succeeded++
    else count.failed++
    if (podAddresses(pod).length > 0) count.withPodIP++
    terminalByNamespace.set(namespace, count)
    terminalPods++
  }

  return {
    capturedAt: snapshot.capturedAt,
    summary: {
      agentRuns: snapshot.agentRuns.items.length,
      activePods: activePods.length,
      scheduledActivePods: scheduledPods.length,
      otherNodeActivePods: scheduledPods.length - nodes.reduce((sum, node) => sum + node.activePods, 0),
      unassignedActivePods: activePods.length - scheduledPods.length,
      terminalPods,
      critical: anomalies.filter((anomaly) => anomaly.severity === 'critical').length,
      warnings: anomalies.filter((anomaly) => anomaly.severity === 'warning').length,
    },
    nodes,
    memory: { metricsAvailable: snapshot.podMetrics != null, runningPods, checkedPods: memoryCheckedPods },
    terminalByNamespace: [...terminalByNamespace.values()].sort((left, right) =>
      compare(left.namespace, right.namespace),
    ),
    anomalies: anomalies.sort(
      (left, right) =>
        compare(left.severity, right.severity) ||
        compare(left.code, right.code) ||
        compare(left.subject, right.subject) ||
        compare(left.message, right.message),
    ),
  }
}

export type FleetReport = ReturnType<typeof inspectAgentFleetHealth>
