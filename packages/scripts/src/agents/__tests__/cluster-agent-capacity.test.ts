import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { measureClusterAgentCapacity } from '../cluster-agent-capacity-core'

const cli = fileURLToPath(new URL('../measure-cluster-agent-capacity.ts', import.meta.url))
const studyFixture = fileURLToPath(
  new URL('../../../../../docs/agents/fixtures/galactic-agent-capacity.json', import.meta.url),
)
const Gi = 1024 ** 3
const capturedAt = '2026-11-28T00:00:30Z'

const node = (name = 'turin', podCidr = '10.244.0.0/23') => ({
  name,
  architecture: 'amd64',
  physicalMemoryBytes: 512 * Gi,
  allocatable: { cpu: 200_000, memory: 500 * Gi, 'ephemeral-storage': 4000 * Gi },
  requested: { cpu: 0, memory: 0, 'ephemeral-storage': 0 },
  workingSetBytes: 0,
  metricsAt: capturedAt,
  maxPods: 500,
  allocatablePods: 500,
  podCidr,
  pods: { active: 0, activeNetworked: 0, succeeded: 0, failed: 0, terminalIpClaims: 0 },
})

const snapshot = () => ({
  capturedAt,
  assumptions: {
    workload: {
      repository: 'proompteng/lab',
      namespaces: [{ name: 'agents', agents: ['codex-agent'] }],
      requests: { cpu: '1', memory: '2Gi', 'ephemeral-storage': '8Gi' },
      p95PodWorkingSet: '2Gi',
      osReservePercent: 0,
      meanRunSeconds: 1800,
      jobTtlSecondsAfterFinished: 86_400,
    },
    controller: {
      concurrency: { perAgent: 200, perNamespace: 200, cluster: 200 },
      rate: { perRepo: 0, perNamespace: 0, cluster: 0, windowSeconds: 60 },
      repoConcurrency: 0,
    },
    cni: { reservedIpsPerNode: 2, extraLeases: [] as { node: string; count: number }[] },
    database: {
      maxConnections: 100,
      reservedConnections: 3,
      otherConnections: 10,
      safeReserveConnections: 10,
      connectionsPerRun: 0,
      pools: {
        controllers: { replicas: 2, maxPerReplica: 16, surge: 1 },
        controlPlane: { replicas: 1, maxPerReplica: 8, surge: 1 },
        audit: { replicas: 0, maxPerReplica: 0, surge: 0 },
      },
    },
    github: {
      requestsPerHour: 5000,
      otherRequestsPerHour: 0,
      safeUtilizationPercent: 100,
      uncachedRequestsPerRun: 1,
      cachedRequestsPerRun: 1,
      cacheEnabled: false,
    },
    arc: {
      scaleSet: 'arc-amd64',
      maxRunners: 10,
      otherRunnerSlots: 0,
      safeUtilizationPercent: 100,
      runnerSecondsPerRun: 0,
    },
  },
  observations: {
    nodes: [node()],
    excluded: [],
    running: [] as { namespace: string; agent: string; count: number }[],
  },
})

type Taint = { key: string; effect: string }
const kubeNode = (
  name: string,
  spec: { podCIDR?: string; unschedulable?: boolean; taints?: Taint[] } = {},
  ready = 'True',
) => ({
  metadata: { name },
  spec: { podCIDR: '10.244.0.0/23', ...spec },
  status: {
    nodeInfo: { architecture: 'amd64' },
    capacity: { memory: '30Gi', pods: '6' },
    allocatable: { cpu: '4', memory: '28Gi', pods: '5', 'ephemeral-storage': '40Gi' },
    conditions: [{ type: 'Ready', status: ready }],
  },
})

const kubePod = (phase: string, podIP?: string, hostNetwork = false, nodeName = 'turin') => ({
  spec: {
    nodeName,
    hostNetwork,
    containers: [{ resources: { requests: { cpu: '200m', memory: '1Gi', 'ephemeral-storage': '1Gi' } } }],
  },
  status: { phase, podIP },
})

const kubeSnapshot = () => ({
  capturedAt,
  assumptions: snapshot().assumptions,
  kubernetes: {
    nodes: {
      items: [kubeNode('turin', { taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] })],
    },
    pods: { items: [kubePod('Running')] },
    nodeMetrics: { items: [{ metadata: { name: 'turin' }, timestamp: capturedAt, usage: { memory: '10Gi' } }] },
    agentRuns: {
      items: [
        {
          metadata: { namespace: 'agents' },
          spec: { agentRef: { name: 'codex-agent' } },
          status: { phase: 'Running' },
        },
        { metadata: { namespace: 'synthesis' }, spec: { agentRef: { name: 'test' } }, status: { phase: 'Running' } },
        {
          metadata: { namespace: 'agents' },
          spec: { agentRef: { name: 'codex-agent' } },
          status: { phase: 'Pending' },
        },
      ],
    },
  },
})

describe('Galactic capacity model', () => {
  test('packs requests and working set together on each node, not against aggregate headroom', () => {
    const input = snapshot()
    const first = node()
    first.allocatable.cpu = 1900
    const second = node('talos-192-168-1-85', '10.244.4.0/23')
    second.allocatable.memory = 3 * Gi
    input.observations.nodes = [first, second, node('talos-192-168-1-194', '10.244.3.0/24')]
    const report = measureClusterAgentCapacity(input)
    expect(report.theoretical.limits.cpuRequests).toBe(201)
    expect(report.theoretical.limits.memoryRequests).toBe(251)
    expect(report.safe).toMatchObject({ total: 2, additional: 2, binding: 'nodePlacement' })
    expect(report.excludedNodes).toContainEqual({ name: 'talos-192-168-1-194', reason: 'outside Galactic build pool' })
  })

  test('charges P95 inclusive of tmpfs, with a separate OS reserve', () => {
    const input = snapshot()
    input.assumptions.workload.osReservePercent = 20
    const worker = node()
    worker.physicalMemoryBytes = 100 * Gi
    worker.workingSetBytes = 18 * Gi
    input.observations.nodes = [worker]
    const report = measureClusterAgentCapacity(input)
    expect(report.theoretical.total).toBe(41)
    expect(report.safe).toMatchObject({ total: 31, binding: 'physicalMemory' })
    expect(report.nodes[0]?.safe.osReserveBytes).toBe(20 * Gi)
    expect(report.tiers[0]?.p95WorkingSetCeilingBytes).toBe((62 * Gi) / 64)
  })

  test('uses effective Kubernetes init, native sidecar, pod-level and overhead requests', () => {
    const input = kubeSnapshot()
    const pod = kubePod('Running')
    const init = (cpu: string, memory: string, restartPolicy?: 'Always') => ({
      restartPolicy,
      resources: { requests: { cpu, memory } },
    })
    const complex = {
      ...pod,
      spec: {
        ...pod.spec,
        initContainers: [init('1e0', '3Gi', 'Always'), init('0.75', '4Gi'), init('400m', '2Gi', 'Always')],
        overhead: { cpu: '50m', memory: '0.5Gi' },
      },
    }
    const podLevel = {
      ...pod,
      spec: { ...pod.spec, resources: { requests: { cpu: '333333n', memory: '1.5Gi' } }, overhead: { cpu: '333333n' } },
    }
    input.kubernetes.pods.items = [complex, podLevel]
    const report = measureClusterAgentCapacity(input)
    expect(report.nodes[0]?.requested).toEqual({ cpu: 1801, memory: 9 * Gi, 'ephemeral-storage': 2 * Gi })
    expect(report.running).toBe(1)
  })

  test('counts pending bound pods and host network correctly and breaks out terminal bloat', () => {
    const input = kubeSnapshot()
    input.kubernetes.pods.items = [
      kubePod('Running', '10.244.0.8'),
      kubePod('Pending'),
      kubePod('Running', '10.244.0.100', true),
      kubePod('Succeeded', '10.244.0.8'), // Already reused by a live pod.
      kubePod('Failed', '10.244.0.9'),
      kubePod('Succeeded', '10.244.0.9'), // Same retained claim, not another lease.
      kubePod('Succeeded', '10.244.0.100', true),
      kubePod('Failed', '10.244.4.9'), // Outside the allocation.
      kubePod('Pending', undefined, false, ''), // Unbound.
    ]
    const report = measureClusterAgentCapacity(input)
    expect(report.nodes[0]).toMatchObject({
      requested: { cpu: 600, memory: 3 * Gi, 'ephemeral-storage': 3 * Gi },
      pods: { active: 3, activeNetworked: 2, succeeded: 3, failed: 2, terminalIpClaims: 1 },
      theoretical: { hostIps: 510, headroom: { podSlots: 2, podIps: 506 } },
      safe: { hostIps: 510, headroom: { podSlots: 2, podIps: 505 } },
    })
    input.assumptions.cni.extraLeases = [{ node: 'turin', count: 4 }]
    const measured = measureClusterAgentCapacity(input)
    expect(measured.nodes[0]?.theoretical.headroom.podIps).toBe(502)
    expect(measured.nodes[0]?.safe.headroom.podIps).toBe(502)
    expect(measured.tiers[0]?.valuesYaml.controller.jobTtlSecondsAfterFinished).toBe(600)
  })

  test('uses the guarded /22 IPv4 capacity and allocatable kubelet limit separately', () => {
    const input = snapshot()
    const worker = node('turin', '10.244.0.0/22')
    worker.maxPods = 600
    worker.allocatablePods = 500
    worker.pods = { active: 498, activeNetworked: 495, succeeded: 100, failed: 5, terminalIpClaims: 0 }
    input.observations.nodes = [worker]
    const report = measureClusterAgentCapacity(input)
    expect(report.nodes[0]?.safe).toMatchObject({ hostIps: 1022, headroom: { podSlots: 2, podIps: 525 } })
    expect(report.safe.binding).toBe('maxPods')
    worker.podCidr = '10.244.0.0/23'
    worker.pods.terminalIpClaims = 12
    expect(measureClusterAgentCapacity(input).safe).toMatchObject({ total: 1, binding: 'podCidr' })
  })

  test('excludes cordoned, non-Ready and untolerated nodes before requiring metrics', () => {
    const input = kubeSnapshot()
    input.kubernetes.nodeMetrics.items = []
    input.kubernetes.nodes.items = [
      kubeNode('turin', { unschedulable: true }),
      kubeNode('talos-192-168-1-85', {}, 'False'),
    ]
    const unready = measureClusterAgentCapacity(input)
    expect(unready.safe.additional).toBe(0)
    expect(unready.excludedNodes.map(({ reason }) => reason)).toEqual(['cordoned', 'not Ready'])
    input.kubernetes.nodes.items[0] = kubeNode('turin', { taints: [{ key: 'dedicated', effect: 'NoSchedule' }] })
    expect(measureClusterAgentCapacity(input).excludedNodes[0]?.reason).toBe('untolerated taint')
  })

  test('enforces AgentRef and namespace caps jointly, preserving running work in watched namespaces', () => {
    const input = snapshot()
    input.assumptions.workload.namespaces = [
      { name: 'agents', agents: ['a', 'b'] },
      { name: 'synthesis', agents: ['c'] },
    ]
    input.observations.running = [
      { namespace: 'agents', agent: 'other-agent', count: 4 },
      { namespace: 'unwatched', agent: 'other-agent', count: 12 },
    ]
    input.assumptions.controller.concurrency = { perAgent: 3, perNamespace: 5, cluster: 100 }
    const report = measureClusterAgentCapacity(input)
    expect(report.safe).toMatchObject({ total: 8, additional: 4, binding: 'namespacePlacement' })
    expect(report.safe.limits).toMatchObject({ perAgent: 13, perNamespace: 10, namespacePlacement: 8 })
    expect(report.tiers[0]?.valuesYaml.controller.concurrency).toEqual({ perAgent: 32, perNamespace: 32, cluster: 100 })
  })

  test('translates admission windows to sustained runs, keeping disabled buckets disabled', () => {
    const input = snapshot()
    input.assumptions.workload.meanRunSeconds = 90
    input.assumptions.controller.rate = { perRepo: 11, perNamespace: 21, cluster: 0, windowSeconds: 60 }
    const report = measureClusterAgentCapacity(input)
    expect(report.safe).toMatchObject({ total: 16, binding: 'repoRate' })
    expect(report.safe.limits).toMatchObject({ namespaceRate: 31, repoRate: 16, clusterRate: null })
    expect(report.tiers[0]?.valuesYaml.controller.rate).toEqual({ perRepo: 43, perNamespace: 43 })
    input.assumptions.controller.repoConcurrency = 12
    expect(measureClusterAgentCapacity(input).tiers[0]?.requiredRepoConcurrency).toBe(64)
  })

  test('reserves DB slots for controller surge, control-plane, audit and direct run connections', () => {
    const input = snapshot()
    input.assumptions.database.pools.audit = { replicas: 1, maxPerReplica: 4, surge: 1 }
    input.assumptions.database.connectionsPerRun = 1
    const report = measureClusterAgentCapacity(input)
    expect(report.database).toMatchObject({ steadyUsed: 57, peakUsed: 95, pools: { audit: { steady: 4, peak: 8 } } })
    expect(report.theoretical).toMatchObject({ total: 43, binding: 'database' })
    expect(report.safe).toMatchObject({ total: 5, binding: 'database' })
    expect(report.tiers[0]?.requiredMaxConnections).toBe(159)
    input.assumptions.database.connectionsPerRun = 0
    expect(measureClusterAgentCapacity(input).safe.limits.database).toBeNull()
    input.assumptions.database.maxConnections = 94
    expect(measureClusterAgentCapacity(input).safe.limits.database).toBe(0)
  })

  test('compares cache scenarios and binds on steady ARC runner demand after the cache', () => {
    const input = snapshot()
    input.assumptions.github = {
      requestsPerHour: 5000,
      otherRequestsPerHour: 1000,
      safeUtilizationPercent: 80,
      uncachedRequestsPerRun: 40,
      cachedRequestsPerRun: 10,
      cacheEnabled: false,
    }
    input.assumptions.arc = {
      scaleSet: 'arc-amd64',
      maxRunners: 10,
      otherRunnerSlots: 2,
      safeUtilizationPercent: 75,
      runnerSecondsPerRun: 120,
    }
    const cold = measureClusterAgentCapacity(input)
    expect(cold.safe).toMatchObject({
      total: 40,
      binding: 'github',
      github: { cold: 40, warm: 160, requestsPerHour: 3200 },
    })
    expect(cold.tiers[0]?.valuesYaml.controllers?.env.vars.AGENTS_AGENT_RUNNER_SHARED_CACHE_HOST_PATH).toBe(
      '/var/lib/agents-workspace-cache',
    )
    input.assumptions.github.cacheEnabled = true
    const warm = measureClusterAgentCapacity(input)
    expect(warm.safe).toMatchObject({
      total: 90,
      binding: 'arc',
      arc: { availableRunners: 8, runnerToAgentRatio: 1 / 15 },
    })
    expect(warm.nextTier).toBe(96)
    expect(warm.tiers[1]?.arc.minMaxRunners).toBe(11)
    expect(warm.tiers[1]?.maxGithubRequestsPerRun).toBe(16)
  })

  test('gives an exact conditional request knob when one request alone can unblock a tier', () => {
    const input = snapshot()
    input.observations.nodes = [
      { ...node(), allocatable: { cpu: 79_999, memory: 500 * Gi, 'ephemeral-storage': 4000 * Gi } },
    ]
    const report = measureClusterAgentCapacity(input, 100)
    expect(report.safe.total).toBe(79)
    expect(report.nextTier).toBe(100)
    const target = report.tiers.find(({ target }) => target === 100)
    expect(target?.conditionalRequestKnobs).toEqual([
      { key: 'controller.defaultWorkload.resources.requests.cpu', maximum: '799m' },
    ])
    input.assumptions.workload.requests.cpu = '799m'
    expect(measureClusterAgentCapacity(input).safe.total).toBe(100)
    input.assumptions.workload.requests.cpu = '800m'
    expect(measureClusterAgentCapacity(input).safe.total).toBe(99)
  })

  test('fails closed for incomplete, stale or invalid input rather than using assumed capacity', () => {
    const input = kubeSnapshot()
    expect(() => measureClusterAgentCapacity({ ...input, observations: {} })).toThrow('exactly one')
    expect(() => measureClusterAgentCapacity({ ...input, capturedAt: '2026-11-28T00:03:00Z' })).toThrow(
      'capture window',
    )
    expect(() =>
      measureClusterAgentCapacity({
        ...input,
        kubernetes: { ...input.kubernetes, pods: { ...input.kubernetes.pods, metadata: { continue: 'not-empty' } } },
      }),
    ).toThrow('pods.metadata.continue')
    input.kubernetes.nodeMetrics.items = []
    expect(() => measureClusterAgentCapacity(input)).toThrow('Missing node working-set metrics')
    const bad = snapshot()
    bad.assumptions.workload.p95PodWorkingSet = 'bogus'
    expect(() => measureClusterAgentCapacity(bad)).toThrow('Invalid Kubernetes resource quantity')
    bad.assumptions.workload.p95PodWorkingSet = '1Gi'
    bad.observations.nodes.push(node('talos-192-168-1-85'))
    expect(() => measureClusterAgentCapacity(bad)).toThrow('Overlapping IPv4 Pod CIDRs')
  })

  test('reports ties in deterministic order', () => {
    const report = measureClusterAgentCapacity(snapshot())
    expect(report.safe).toMatchObject({
      total: 200,
      binding: 'cpuRequests',
      bindings: ['cpuRequests', 'perAgent', 'perNamespace', 'clusterConcurrency'],
    })
  })
})

describe('capacity CLI', () => {
  test('reports the study fixture as clean JSON and includes actionable Markdown values', () => {
    const args = [process.execPath, cli, '--fixture', studyFixture, '--format']
    const json = Bun.spawnSync([...args, 'json'])
    expect(json.exitCode).toBe(0)
    expect(json.stderr.toString()).toBe('')
    expect(JSON.parse(json.stdout.toString())).toMatchObject({
      theoretical: { total: 32, nodeTotal: 60 },
      safe: { total: 32, nodeTotal: 51, binding: 'perAgent' },
      running: 6,
      nextTier: 64,
    })
    const markdown = Bun.spawnSync([...args, 'markdown'])
    expect(markdown.exitCode).toBe(0)
    expect(markdown.stdout.toString()).toContain('64-run tier: Agents Helm values')
    expect(markdown.stdout.toString()).toContain('jobTtlSecondsAfterFinished: 600')
  })

  test('reads a captured kubectl JSON envelope from stdin and rejects invalid flags without echoing values', () => {
    const json = Bun.spawnSync([process.execPath, cli, '--fixture', '-', '--format', 'json'], {
      stdin: new TextEncoder().encode(JSON.stringify(kubeSnapshot())),
    })
    expect(json.exitCode).toBe(0)
    expect(JSON.parse(json.stdout.toString())).toMatchObject({ running: 1, safe: { total: 4, binding: 'cpuRequests' } })
    const invalid = Bun.spawnSync([process.execPath, cli, '--unexpected', 'private-value'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stdout.toString()).toBe('')
    expect(invalid.stderr.toString()).not.toContain('private-value')
  })

  test('live mode only performs explicit-context kubectl reads; access errors do not replay kubectl output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cluster-agent-capacity-test-'))
    try {
      const assumptions = join(directory, 'assumptions.json')
      writeFileSync(assumptions, JSON.stringify(snapshot().assumptions))
      const fixture = kubeSnapshot()
      fixture.kubernetes.nodeMetrics.items[0]!.timestamp = new Date().toISOString()
      writeFileSync(
        join(directory, 'kubectl'),
        `#!${process.execPath}
const [context, timeout, operation, type, ...args] = Bun.argv.slice(2)
if (context !== '--context=galactic-test' || timeout !== '--request-timeout=20s' || operation !== 'get') process.exit(1)
if (Bun.env.MOCK_DENY && type === 'pods') {
  console.error('Forbidden: private-value')
  process.exit(1)
}
if (['pods', 'agentruns.agents.proompteng.ai'].includes(type) && !args.includes('--all-namespaces')) process.exit(1)
const results = ${JSON.stringify(fixture.kubernetes)}
const result = results[({ nodes: 'nodes', pods: 'pods', 'agentruns.agents.proompteng.ai': 'agentRuns', '--raw': 'nodeMetrics' })[type]]
if (!result) process.exit(1)
console.log(JSON.stringify(result))
`,
        { mode: 0o700 },
      )
      const cmd = [
        process.execPath,
        cli,
        '--context',
        'galactic-test',
        '--assumptions',
        assumptions,
        '--format',
        'json',
      ]
      const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` }
      const live = Bun.spawnSync(cmd, { env })
      expect(live.exitCode).toBe(0)
      expect(JSON.parse(live.stdout.toString())).toMatchObject({ running: 1, safe: { total: 4 } })
      const denied = Bun.spawnSync(cmd, { env: { ...env, MOCK_DENY: '1' } })
      expect(denied.exitCode).toBe(1)
      expect(denied.stdout.toString()).toBe('')
      expect(denied.stderr.toString().trim()).toBe('kubectl pods: access denied (exit 1)')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
