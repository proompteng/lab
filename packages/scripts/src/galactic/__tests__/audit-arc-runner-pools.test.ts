import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditArcRunnerPools } from '../audit-arc-runner-pools-core'

const now = '2026-11-28T12:00:00Z'
const old = '2026-11-28T11:55:00Z'
const recent = '2026-11-28T11:59:00Z'
const gib = 2 ** 30
const fakeSecret = 'sensitive-fixture-value-do-not-echo'
const poolLabels = (pool: string, namespace = 'arc') => ({
  'actions.github.com/scale-set-name': pool,
  'actions.github.com/scale-set-namespace': namespace,
})
const workerSpec = {
  nodeSelector: { 'kubernetes.io/arch': 'amd64' },
  containers: [{ name: 'runner', resources: { requests: { cpu: '4', memory: '8Gi' } } }],
}

function pool(name = 'arc-amd64', maxRunners = 10) {
  return {
    kind: 'AutoscalingRunnerSet',
    metadata: { namespace: 'arc', name },
    spec: {
      maxRunners,
      template: {
        spec: name === 'arc-arm64' ? { ...workerSpec, nodeSelector: { 'kubernetes.io/arch': 'arm64' } } : workerSpec,
      },
      githubConfigUrl: fakeSecret,
    },
    status: { phase: 'Running' },
  }
}

function runner(name: string, phase = 'Pending', ready = false, createdAt = old) {
  return {
    kind: 'EphemeralRunner',
    metadata: {
      name,
      namespace: 'arc',
      uid: `uid-${name}`,
      labels: poolLabels('arc-amd64'),
      creationTimestamp: createdAt,
    },
    status: { phase, ready, message: fakeSecret },
  }
}

function pod(
  name: string,
  {
    node = 'turin',
    owner,
    namespace = 'arc',
    ip = '10.244.0.2',
    phase = 'Running',
    createdAt = old,
  }: { node?: string; owner?: string; namespace?: string; ip?: string; phase?: string; createdAt?: string } = {},
) {
  return {
    kind: 'Pod',
    metadata: {
      namespace,
      name,
      creationTimestamp: createdAt,
      ownerReferences: owner ? [{ uid: `uid-${owner}`, kind: 'EphemeralRunner', controller: true }] : [],
    },
    spec: { containers: workerSpec.containers, nodeName: node || undefined },
    status: { phase, podIP: ip || undefined, podIPs: ip ? [{ ip }] : [] },
  }
}

function node({
  name = 'turin',
  arch = 'amd64',
  cpu = '12',
  memory = '32Gi',
  pods = '40',
  cidr = '10.244.0.0/24',
} = {}) {
  return {
    kind: 'Node',
    metadata: { name, labels: { 'kubernetes.io/arch': arch, 'kubernetes.io/hostname': name } },
    spec: { podCIDR: cidr, podCIDRs: [cidr] },
    status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu, memory, pods } },
  }
}

const list = (items: unknown[]) => ({ apiVersion: 'v1', kind: 'List', metadata: {}, items })
function fixture({
  sets = [pool()],
  runners = [],
  pods = [],
  nodes = [node()],
}: { sets?: unknown[]; runners?: unknown[]; pods?: unknown[]; nodes?: unknown[] } = {}) {
  return {
    observedAt: now,
    runnerSets: list(sets),
    ephemeralRunners: list(runners),
    pods: list(pods),
    nodes: list(nodes),
  }
}

function unschedulable(message: string) {
  const waiting = pod('waiting-pod', { node: '', owner: 'waiting', ip: '', phase: 'Pending' })
  return {
    ...waiting,
    status: {
      ...waiting.status,
      conditions: [
        { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message, lastTransitionTime: recent },
      ],
    },
  }
}

test('counts ARC Pending+ready as idle and uses the newest owned pod or transition for an actual wait', () => {
  const staleOwner = pod('wrong-uid', { owner: 'stale-runner' })
  const report = auditArcRunnerPools(
    fixture({
      nodes: [node({ cpu: '32', memory: '64Gi' })],
      runners: [runner('busy', 'Running', true), runner('warm', 'Pending', true), runner('waiting'), runner('stale')],
      pods: [
        pod('warm-pod', { owner: 'warm' }),
        pod('busy-pod', { owner: 'busy', ip: '10.244.0.3' }),
        pod('old-attempt', { owner: 'waiting', createdAt: '2026-11-28T11:54:00Z' }),
        unschedulable(`volume zone conflict ${fakeSecret}`),
        staleOwner,
      ],
    }),
  )
  const [set] = report.runnerSets
  expect(set).toMatchObject({
    active: 4,
    assigned: 1,
    readyIdle: 1,
    schedulingBlocked: 1,
    stuck: 1,
    estimatedAdditionalSlots: 4,
    saturated: true,
  })
  expect(set.pending).toEqual([
    { name: 'stale', pod: null, stage: 'no-pod', ageSeconds: 300, stuck: true, blocked: false, schedulerLimits: [] },
    {
      name: 'waiting',
      pod: 'waiting-pod',
      stage: 'unscheduled',
      ageSeconds: 60,
      stuck: false,
      blocked: true,
      schedulerLimits: [],
    },
  ])
  expect(report.topBottleneck).toEqual({ runnerSet: 'arc/arc-amd64', reason: 'pending-scheduling' })
  expect(JSON.stringify(report)).not.toContain(fakeSecret)
})

test('treats a runner unbound past the stuck threshold as a scheduling block, not merely a young Pending Pod', () => {
  const report = auditArcRunnerPools(
    fixture({
      runners: [runner('aged'), runner('fresh')],
      pods: [
        pod('aged-pod', { node: '', owner: 'aged', ip: '', phase: 'Pending' }),
        pod('fresh-pod', { node: '', owner: 'fresh', ip: '', phase: 'Pending', createdAt: recent }),
      ],
    }),
  )
  expect(report.runnerSets[0]).toMatchObject({
    estimatedAdditionalSlots: 3,
    bottleneck: 'pending-scheduling',
    schedulingBlocked: 1,
    stuck: 1,
    saturated: true,
  })
  expect(report.runnerSets[0].pending).toMatchObject([
    { ageSeconds: 300, blocked: true },
    { ageSeconds: 60, blocked: false },
  ])
})

test('counts failed and deleting registrations against cap but excludes completed and out-of-scope runners', () => {
  const terminating = runner('terminating', 'Running', true)
  const otherNamespace = runner('other')
  const report = auditArcRunnerPools(
    fixture({
      sets: [pool('arc-amd64', 3)],
      runners: [
        runner('done', 'Succeeded'),
        runner('outdated', 'Outdated'),
        runner('failed', 'Failed'),
        runner('warm', 'Pending', true),
        { ...terminating, metadata: { ...terminating.metadata, deletionTimestamp: recent } },
        { ...otherNamespace, metadata: { ...otherNamespace.metadata, namespace: 'other' } },
      ],
      pods: [pod('warm-pod', { owner: 'warm' }), pod('terminating-pod', { owner: 'terminating', ip: '10.244.0.3' })],
    }),
  )
  expect(report.unmatchedActiveRunners).toBe(1)
  expect(report.runnerSets[0]).toMatchObject({
    active: 1,
    maxRunners: 3,
    utilizationPercent: 33.3,
    readyIdle: 1,
    capSlots: 0,
    failed: 1,
    terminating: 1,
    bottleneck: 'max-runners',
    saturated: true,
  })
})

test('uses scheduler-shaped CPU/RAM requests for every bound workload and tracks ARC tmpfs independently', () => {
  const work = pod('build', { owner: 'busy' })
  const background = pod('background', { namespace: 'other', ip: '10.244.0.4' })
  const draining = pod('draining', { namespace: 'other', ip: '10.244.0.3' })
  const report = auditArcRunnerPools(
    fixture({
      runners: [runner('busy', 'Running', true)],
      pods: [
        {
          ...work,
          spec: {
            ...work.spec,
            containers: [
              {
                resources: { limits: { cpu: '1.25', memory: '8Gi' } },
                env: [{ name: 'TEST_VALUE', value: fakeSecret }],
              },
              { resources: { requests: { cpu: '250000u', memory: '256Mi' } } },
            ],
            initContainers: [
              { restartPolicy: 'Always', resources: { requests: { cpu: '500m', memory: '512Mi' } } },
              { resources: { requests: { cpu: '2500m', memory: '12Gi' } } },
            ],
            overhead: { cpu: '50m', memory: '32Mi' },
            volumes: [
              { emptyDir: { medium: 'Memory', sizeLimit: '16Gi' } },
              { emptyDir: { medium: 'Memory' } },
              { emptyDir: { sizeLimit: '128Gi' } },
            ],
          },
        },
        {
          ...background,
          spec: { ...background.spec, hostNetwork: true, resources: { requests: { cpu: '2e0', memory: '4Gi' } } },
        },
        {
          ...draining,
          metadata: { ...draining.metadata, deletionTimestamp: recent },
          spec: { ...draining.spec, containers: [{ resources: { requests: { cpu: '100m', memory: '1Gi' } } }] },
        },
        pod('retained-history', { phase: 'Succeeded', ip: '10.244.0.5' }),
      ],
    }),
  )
  const request = 12.5 * gib + 32 * 2 ** 20
  expect(report.nodes[0]).toMatchObject({
    pods: { requested: 3, allocatable: 40, runners: 1, free: 37 },
    cpuMillis: { requested: 5150, allocatable: 12000, runners: 3050, free: 6850 },
    memoryBytes: { requested: request + 5 * gib, allocatable: 32 * gib, runners: request, free: 27 * gib - request },
    runnerTmpfs: { volumes: 2, boundedBytes: 16 * gib, unboundedVolumes: 1 },
    podCidr: { assignedIps: 2, usableIpsEstimate: 253, freeIpsEstimate: 251 },
  })
  expect(report.runnerSets[0]).toMatchObject({ estimatedAdditionalSlots: 1, bottleneck: 'node-cpu', saturated: false })
})

test.each([
  ['max-runners', fixture({ sets: [pool('arc-amd64', 0)] })],
  [
    'node-cpu',
    fixture({
      nodes: [node({ cpu: '3999m' })],
      runners: [runner('waiting')],
      pods: [unschedulable('0/1 nodes are available: 1 Insufficient cpu.')],
    }),
  ],
  ['node-memory', fixture({ nodes: [node({ memory: '8191Mi' })] })],
  ['node-pods', fixture({ nodes: [node({ pods: '1' })], pods: [pod('background', { namespace: 'other' })] })],
  [
    'pod-cidr',
    fixture({
      nodes: [node({ cidr: '10.244.0.0/29', cpu: '64', memory: '128Gi' })],
      pods: [2, 3, 4, 5, 6].map((i) => pod(`background-${i}`, { namespace: 'other', ip: `10.244.0.${i}` })),
    }),
  ],
] as const)('identifies %s as a zero-slot scale-out limit', (reason, input) => {
  const report = auditArcRunnerPools(input)
  expect(report.saturated).toBe(true)
  expect(report.topBottleneck.reason).toBe(reason)
  expect(report.runnerSets[0].estimatedAdditionalSlots).toBe(0)
})

test('reports a binding cap before saturation and keeps cap precedence on a tie', () => {
  const report = auditArcRunnerPools(fixture({ sets: [pool('arc-amd64', 3)] }))
  expect(report.runnerSets[0]).toMatchObject({
    capSlots: 3,
    physicalSlots: 3,
    estimatedAdditionalSlots: 3,
    bottleneck: 'max-runners',
    saturated: false,
  })
})

test('assigns no phantom slots across CPUs and memory on different nodes and excludes ineligible nodes', () => {
  const taint = { key: 'dedicated', value: 'ci', effect: 'NoSchedule' }
  const cpuNode = node({ cpu: '8', memory: '4Gi' })
  const excluded = node({ name: 'tainted' })
  const cordoned = node({ name: 'cordoned' })
  const unhealthy = node({ name: 'unhealthy' })
  const set = pool()
  const report = auditArcRunnerPools(
    fixture({
      sets: [
        {
          ...set,
          spec: { ...set.spec, template: { spec: { ...workerSpec, tolerations: [{ ...taint, operator: 'Equal' }] } } },
        },
      ],
      nodes: [
        { ...cpuNode, spec: { ...cpuNode.spec, taints: [taint] } },
        node({ name: 'memory-node', cpu: '2' }),
        node({ name: 'altra', arch: 'arm64' }),
        { ...unhealthy, status: { ...unhealthy.status, conditions: [{ type: 'Ready', status: 'False' }] } },
        { ...cordoned, spec: { ...cordoned.spec, unschedulable: true } },
        { ...excluded, spec: { ...excluded.spec, taints: [{ ...taint, value: 'other' }] } },
      ],
    }),
  )
  const [result] = report.runnerSets
  expect(result.nodeFits.map(({ node, slots }) => [node, slots])).toEqual([
    ['memory-node', 0],
    ['turin', 0],
  ])
  expect(result).toMatchObject({ physicalSlots: 0, bottleneck: 'node-cpu' })
})

test('counts distinct allocatable IPs across a /23 and separates bound pods without an allocatable IP', () => {
  const report = auditArcRunnerPools(
    fixture({
      nodes: [node({ cidr: '10.244.0.0/23' })],
      pods: [
        pod('one'),
        pod('duplicate'),
        pod('second-half', { ip: '10.244.1.254' }),
        pod('not-broadcast', { ip: '10.244.0.255' }),
        pod('gateway', { ip: '10.244.0.1' }),
        pod('broadcast', { ip: '10.244.1.255' }),
        pod('outside-range', { ip: '10.244.2.1' }),
        pod('bound-waiting', { ip: '', phase: 'Pending' }),
        pod('unbound', { node: '', ip: '', phase: 'Pending' }),
      ],
    }),
  )
  expect(report.nodes[0].podCidr).toEqual({
    cidr: '10.244.0.0/23',
    assignedIps: 3,
    usableIpsEstimate: 509,
    freeIpsEstimate: 506,
    boundWithoutInRangeIp: 4,
  })
  expect(report.nodes[0].pods.requested).toBe(8)
})

test('does not claim capacity or saturation from a missing/unsupported CIDR; host-network runners do not need an IP', () => {
  const unknownCidr = node()
  const input = fixture({ nodes: [{ ...unknownCidr, spec: { podCIDRs: ['10.244.0.0/24', 'fd00::/64'] } }] })
  const unknown = auditArcRunnerPools(input)
  expect(unknown.nodes[0].podCidr).toBeNull()
  expect(unknown.runnerSets[0]).toMatchObject({
    physicalSlots: null,
    estimatedAdditionalSlots: null,
    saturated: false,
    bottleneck: 'unknown',
  })

  const host = pool()
  const hostReport = auditArcRunnerPools({
    ...input,
    runnerSets: list([{ ...host, spec: { template: { spec: { ...workerSpec, hostNetwork: true } } } }]),
  })
  expect(hostReport.runnerSets[0]).toMatchObject({
    maxRunners: null,
    utilizationPercent: null,
    estimatedAdditionalSlots: 3,
    bottleneck: 'node-cpu',
  })
  const drained = auditArcRunnerPools({ ...input, runnerSets: list([pool('arc-amd64', 0)]) })
  expect(drained.runnerSets[0]).toMatchObject({
    maxRunners: 0,
    utilizationPercent: null,
    estimatedAdditionalSlots: 0,
    bottleneck: 'max-runners',
    saturated: true,
  })
})

test('recognizes loss of eligible nodes or an explicitly outdated scale set instead of reporting healthy capacity', () => {
  const noEligible = auditArcRunnerPools(fixture({ nodes: [node({ name: 'altra', arch: 'arm64' })] }))
  expect(noEligible.runnerSets[0]).toMatchObject({
    estimatedAdditionalSlots: 0,
    bottleneck: 'pending-scheduling',
    saturated: true,
  })
  const outdated = auditArcRunnerPools(fixture({ sets: [{ ...pool(), status: { phase: 'Outdated' } }] }))
  expect(outdated.runnerSets[0]).toMatchObject({
    estimatedAdditionalSlots: 3,
    bottleneck: 'pool-outdated',
    saturated: true,
  })
})

test('rejects paged, mislabeled, and duplicate kubectl data rather than calculating partial headroom', () => {
  const input = fixture()
  expect(() => auditArcRunnerPools({ ...input, pods: { ...input.pods, metadata: { continue: fakeSecret } } })).toThrow(
    'expected a complete Pod list',
  )
  expect(() => auditArcRunnerPools({ ...input, nodes: list([pool()]) })).toThrow('invalid Node at item 1')
  expect(() => auditArcRunnerPools({ ...input, nodes: list([node(), node()]) })).toThrow('duplicate Node at item 2')
  expect(() => auditArcRunnerPools({ ...input, runnerSets: list([]) })).toThrow('no AutoscalingRunnerSets found')
})

const cli = join(import.meta.dir, '../audit-arc-runner-pools.ts')
const run = (args: string[], env = process.env) => {
  const result = Bun.spawnSync([process.execPath, cli, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

function inTempDir(callback: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'arc-pools-'))
  try {
    callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('CLI replays a fixture deterministically in both formats and distinguishes saturation from bad input', () =>
  inTempDir((dir) => {
    const file = join(dir, 'first.json')
    const reversed = join(dir, 'reversed.json')
    const altra = pool('arc-arm64', 0)
    const input = fixture({
      sets: [altra, pool('arc-amd64', 0)],
      runners: [runner('second'), runner('first')],
      nodes: [node(), node({ name: 'altra', arch: 'arm64' })],
      pods: [pod('rogue'), pod('earlier')],
    })
    writeFileSync(file, JSON.stringify(input))
    writeFileSync(
      reversed,
      JSON.stringify({
        ...input,
        runnerSets: list(input.runnerSets.items.toReversed()),
        ephemeralRunners: list(input.ephemeralRunners.items.toReversed()),
        nodes: list(input.nodes.items.toReversed()),
        pods: list(input.pods.items.toReversed()),
      }),
    )
    for (const fmt of ['json', 'markdown']) {
      const first = run(['--fixture', file, '--format', fmt])
      expect(first).toMatchObject({ exit: 0, stderr: '' })
      expect(first).toEqual(run(['--fixture', reversed, '--format', fmt]))
      expect(first.stdout).not.toContain(fakeSecret)
      expect(run(['--fixture', file, '--format', fmt, '--fail-on-saturated'])).toEqual({ ...first, exit: 2 })
      if (fmt === 'json')
        expect(JSON.parse(first.stdout)).toMatchObject({
          topBottleneck: { runnerSet: 'arc/arc-amd64', reason: 'max-runners' },
          saturated: true,
        })
      else expect(first.stdout).toContain('Top bottleneck: **maxRunners cap** (arc/arc-amd64).')
    }
    writeFileSync(file, JSON.stringify(fixture()))
    expect(run(['--fixture', file, '--fail-on-saturated']).exit).toBe(0)
    writeFileSync(file, fakeSecret)
    expect(run(['--fixture', file])).toEqual({
      exit: 1,
      stdout: '',
      stderr: 'ARC audit: could not read fixture as JSON\n',
    })
    expect(run([])).toEqual({ exit: 1, stdout: '', stderr: 'ARC audit: live mode requires an explicit --context\n' })
  }))

test('live CLI invokes only scoped reads and never emits kubectl output or fixture values on failure', () =>
  inTempDir((dir) => {
    const input = fixture({ sets: [{ ...pool(), metadata: { namespace: 'builds', name: 'arc-amd64' } }] })
    for (const key of ['runnerSets', 'ephemeralRunners', 'pods', 'nodes'] as const) {
      writeFileSync(join(dir, key), JSON.stringify(input[key]))
    }
    writeFileSync(
      join(dir, 'kubectl'),
      `#!/bin/sh
printf '%s\n' '${fakeSecret}' >&2
case "$*" in
  '--context=galactic-test --request-timeout=30s get autoscalingrunnersets.actions.github.com --namespace=builds -o json') key=runnerSets ;;
  '--context=galactic-test --request-timeout=30s get ephemeralrunners.actions.github.com --namespace=builds -o json') key=ephemeralRunners ;;
  '--context=galactic-test --request-timeout=30s get pods --all-namespaces -o json') key=pods ;;
  '--context=galactic-test --request-timeout=30s get nodes -o json') key=nodes ;;
  *) exit 8 ;;
esac
if [ "$FAIL_PODS" = yes ] && [ "$key" = pods ]; then
  printf '%s\n' '${fakeSecret}'
  exit 7
fi
exec cat "$AUDIT_INPUT_DIR/$key"
`,
      { mode: 0o700 },
    )
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, AUDIT_INPUT_DIR: dir, FAIL_PODS: 'no' }
    const args = ['--context', 'galactic-test', '--namespace', 'builds', '--format', 'json']
    const live = run(args, env)
    expect(live.exit).toBe(0)
    expect(live.stderr).toBe('')
    expect(live.stdout).not.toContain(fakeSecret)
    expect(JSON.parse(live.stdout)).toMatchObject({
      topBottleneck: { runnerSet: 'builds/arc-amd64', reason: 'node-cpu' },
      saturated: false,
    })
    expect(run(args, { ...env, FAIL_PODS: 'yes' })).toEqual({
      exit: 1,
      stdout: '',
      stderr: 'ARC audit: could not list pods (kubectl exit 7); check context and list access\n',
    })
  }))
