import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'

import { fleetSnapshot, inspectAgentFleetHealth } from '../inspect-agent-fleet-health-core'

type Fixture = z.input<typeof fleetSnapshot>
type Run = Fixture['agentRuns']['items'][number]
type Job = Fixture['jobs']['items'][number]
type Pod = Fixture['pods']['items'][number]
type Node = Fixture['nodes']['items'][number]

const NOW = '2026-11-28T12:00:00.000Z'
const TURIN = 'turin'
const ALTRA = 'talos-192-168-1-85'
const RUN_LABEL = 'agents.proompteng.ai/agent-run'
const RUN_UID_LABEL = 'agents.proompteng.ai/run-uid'
const ACCOUNT = 'codex-auto-ontology-runner'
const AUDIENCE = 'agents.proompteng.ai/auto-ontology-mcp'
const MOUNT = { name: 'codex-mcp-identity', mountPath: '/var/run/secrets/agents-auto-ontology-mcp' }
const SENSITIVE = 'postgresql://fixture-user:fixture-password@never-print.example/db'

const list = <T>(...items: T[]) => ({ items })
const fixture = (overrides: Partial<Fixture> = {}): Fixture => ({
  capturedAt: NOW,
  agentRuns: list(),
  jobs: list(),
  pods: list(),
  nodes: list(),
  podMetrics: list(),
  ...overrides,
})
const inspect = (input: Fixture) => inspectAgentFleetHealth(fleetSnapshot.parse(input))

const run = (name: string, status: Run['status'] = null, ageSeconds = 181, namespace = 'agents'): Run => ({
  metadata: {
    name,
    namespace,
    uid: `${namespace}-${name}-uid`,
    creationTimestamp: new Date(Date.parse(NOW) - 1000 * ageSeconds).toISOString(),
  },
  status,
})

const projection = (audience = AUDIENCE, path = 'token') => ({
  name: MOUNT.name,
  projected: { sources: [{ serviceAccountToken: { audience, path } }] },
})
const runner = (memory = '1Gi') => ({ name: 'agent-runner', resources: { limits: { memory } }, volumeMounts: [MOUNT] })

const pod = (
  name: string,
  overrides: { metadata?: Partial<Pod['metadata']>; spec?: Partial<Pod['spec']>; status?: Pod['status'] } = {},
): Pod => ({
  metadata: { name, namespace: 'agents', labels: { [RUN_LABEL]: name }, ...overrides.metadata },
  spec: { serviceAccountName: ACCOUNT, volumes: [projection()], containers: [runner()], ...overrides.spec },
  status: { phase: 'Pending', ...overrides.status },
})

const worker = (name: string, arch: string, podCIDR: string): Node => ({
  metadata: { name, labels: { 'kubernetes.io/arch': arch } },
  spec: { podCIDR },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
})

const jobOwner = (name: string, uid: string) => ({ kind: 'Job', apiVersion: 'batch/v1', name, uid })
const runOwner = (name: string, uid: string) => ({
  kind: 'AgentRun',
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  name,
  uid,
})
const metric = (name: string, memory: string, namespace = 'agents') => ({
  metadata: { name, namespace },
  containers: [{ name: 'agent-runner', usage: { memory } }],
})

describe('AgentRun admission and phase desync', () => {
  test('joins the Pending RateLimit condition to a running Pod through Job ownership before runtimeRef exists', () => {
    const pending = run(
      'burst',
      {
        phase: 'Pending',
        conditions: [{ type: 'Blocked', status: 'True', reason: 'RateLimit' }],
      },
      2,
    )
    const report = inspect(
      fixture({
        agentRuns: list(pending),
        jobs: list({
          metadata: {
            name: 'burst-job',
            namespace: 'agents',
            uid: 'job-uid',
            ownerReferences: [runOwner('burst', 'agents-burst-uid')],
          },
          status: { active: 1 },
        }),
        pods: list(
          pod('burst-job-pod', {
            metadata: { labels: {}, ownerReferences: [jobOwner('burst-job', 'job-uid')] },
            status: { phase: 'Running' },
          }),
        ),
        podMetrics: list(metric('burst-job-pod', '360Mi')),
      }),
    )
    expect(report.anomalies).toEqual([
      {
        code: 'phase_pod_desync',
        severity: 'critical',
        subject: 'agents/burst',
        message: 'AgentRun phase is Pending (Blocked:RateLimit), but Pod agents/burst-job-pod is Running.',
      },
    ])
  })

  test('detects terminal and ready evidence from referenced Jobs or Pods even when phase is null', () => {
    const report = inspect(
      fixture({
        agentRuns: list(
          run('completed', { runtimeRef: { type: 'job', name: 'complete-job', uid: 'complete' } }),
          run('failed', { phase: null, runtimeRef: { type: 'job', name: 'failed-job', uid: 'failed' } }),
          run('ready', { runtimeRef: { type: 'workflow', name: 'ready-job', namespace: 'synthesis', uid: 'ready' } }),
          run('pod-only', { runtimeRef: { type: 'job', name: 'gone-job', uid: 'gone' } }),
        ),
        jobs: list(
          {
            metadata: { name: 'complete-job', namespace: 'agents', uid: 'complete' },
            status: { conditions: [{ type: 'Complete', status: 'True' }] },
          },
          {
            metadata: { name: 'failed-job', namespace: 'agents', uid: 'failed' },
            status: { conditions: [{ type: 'Failed', status: 'True' }] },
          },
          { metadata: { name: 'ready-job', namespace: 'synthesis', uid: 'ready' }, status: { ready: 1 } },
        ),
        pods: list(
          pod('completed-pod', {
            metadata: { labels: {}, ownerReferences: [jobOwner('gone-job', 'gone')] },
            status: { phase: 'Succeeded' },
          }),
        ),
      }),
    )
    expect(report.anomalies.map(({ code, message }) => [code, message])).toEqual([
      ['phase_pod_desync', 'AgentRun phase is null, but Job agents/complete-job is Succeeded.'],
      ['phase_pod_desync', 'AgentRun phase is null, but Job agents/failed-job is Failed.'],
      ['phase_pod_desync', 'AgentRun phase is null, but Pod agents/completed-pod is Succeeded.'],
      ['phase_pod_desync', 'AgentRun phase is null, but Job synthesis/ready-job is Running.'],
    ])
  })

  test('requires age strictly over 180s and no active Job or Pod for stuck admission', () => {
    const report = inspect(
      fixture({
        agentRuns: list(
          run('boundary', { phase: 'Pending' }, 180),
          run('just-over', { phase: 'Pending' }, 180.001),
          run('unset'),
          run('admitted'),
          run('active-job', { phase: 'Pending', runtimeRef: { type: 'job', name: 'starting-job' } }),
          { ...run('temporal'), spec: { runtime: { type: 'temporal' } } },
          { ...run('deleting'), metadata: { ...run('deleting').metadata, deletionTimestamp: NOW } },
        ),
        jobs: list({ metadata: { name: 'starting-job', namespace: 'agents' }, status: { active: 1 } }),
        pods: list(
          pod('admitted', {
            metadata: { labels: { [RUN_LABEL]: 'admitted', [RUN_UID_LABEL]: 'agents-admitted-uid' } },
          }),
        ),
      }),
    )
    expect(report.anomalies.map(({ code, subject }) => [code, subject])).toEqual([
      ['stuck_admission', 'agents/just-over'],
      ['stuck_admission', 'agents/unset'],
    ])
  })

  test('does not match recycled UIDs, another namespace, or nonterminal Job failure counts', () => {
    const retriedJob = { metadata: { name: 'retry-job', namespace: 'agents' }, status: { failed: 1, active: 1 } }
    const runs = [
      run('recycled', { phase: 'Pending', runtimeRef: { type: 'job', name: 'job', uid: 'old' } }),
      run('current', { phase: 'Pending', runtimeRef: { type: 'job', name: 'job', uid: 'new' } }),
      run('retry', { phase: 'Pending', runtimeRef: { type: 'job', name: 'retry-job' } }),
      run('new-owner', { phase: 'Pending', runtimeRef: { type: 'job', name: 'owned-job', uid: 'owner-job' } }),
    ]
    const input = fixture({
      agentRuns: list(...runs),
      jobs: list<Job>(
        { metadata: { name: 'job', namespace: 'agents', uid: 'new' }, status: { ready: 1 } },
        { metadata: { name: 'job', namespace: 'synthesis', uid: 'old' }, status: { ready: 1 } },
        {
          metadata: {
            name: 'owned-job',
            namespace: 'agents',
            uid: 'owner-job',
            ownerReferences: [runOwner('new-owner', 'agents-new-owner-uid')],
          },
        },
        retriedJob,
      ),
      pods: list(
        pod('stale', {
          metadata: {
            labels: { [RUN_LABEL]: 'new-owner', [RUN_UID_LABEL]: 'old-run' },
            ownerReferences: [jobOwner('owned-job', 'old-job')],
          },
          status: { phase: 'Failed' },
        }),
      ),
    })
    const report = inspect(input)
    expect(report.anomalies.map(({ code, subject }) => [code, subject])).toEqual([
      ['phase_pod_desync', 'agents/current'],
      ['stuck_admission', 'agents/new-owner'],
      ['stuck_admission', 'agents/recycled'],
    ])
    expect(inspect({ ...input, agentRuns: list(...runs.toReversed()) })).toEqual(report)
    expect(report.summary.terminalPods).toBe(1)
  })
})

describe('fleet spread, identity, and resources', () => {
  const turin = worker(TURIN, 'amd64', '10.244.2.0/23')
  const altra = worker(ALTRA, 'arm64', '10.244.4.0/25')
  const fleet = (onTurin: number) =>
    Array.from({ length: 100 }, (_, index) =>
      pod(`fleet-${index}`, { spec: { nodeName: index < onTurin ? TURIN : ALTRA } }),
    )
  const peerClaims = Array.from({ length: 25 }, (_, index) =>
    pod(`other-${index}`, {
      metadata: { namespace: 'kube-system', labels: {} },
      spec: { nodeName: ALTRA },
      status: { phase: index === 0 ? 'Succeeded' : 'Running', podIP: `10.244.4.${index + 2}` },
    }),
  )

  test('uses strict spread and IP thresholds, including claims from other namespaces and terminal Pods', () => {
    const input = (onTurin: number, claims: Pod[]) =>
      fixture({
        nodes: list(turin, altra),
        pods: list(...fleet(onTurin), ...claims, pod('unassigned')),
      })
    expect(inspect(input(85, [])).anomalies).toEqual([])
    const boundary = inspect(input(90, peerClaims))
    expect(boundary.nodes[1]?.freePodIPs).toBe(100)
    expect(boundary.anomalies).toEqual([])

    const duplicate = pod('duplicate', {
      metadata: { namespace: 'synthesis', labels: {} },
      spec: { nodeName: ALTRA },
      status: { phase: 'Running', podIPs: [{ ip: '10.244.4.2' }, { ip: '2001:db8::1' }] },
    })
    const hostNetwork = pod('host-network', {
      metadata: { namespace: 'kube-system', labels: {} },
      spec: { nodeName: ALTRA, hostNetwork: true },
      status: { podIP: '10.244.4.55' },
    })
    const report = inspect(input(90, [...peerClaims.slice(0, -1), duplicate, hostNetwork]))
    expect(report.nodes).toEqual([
      {
        name: TURIN,
        architecture: 'amd64',
        schedulable: true,
        activePods: 90,
        scheduledSharePercent: 90,
        freePodIPs: 509,
      },
      {
        name: ALTRA,
        architecture: 'arm64',
        schedulable: true,
        activePods: 10,
        scheduledSharePercent: 10,
        freePodIPs: 101,
      },
    ])
    expect(report.summary).toMatchObject({
      activePods: 101,
      scheduledActivePods: 100,
      unassignedActivePods: 1,
      terminalPods: 0,
    })
    expect(report.anomalies).toEqual([
      expect.objectContaining({ code: 'node_skew', subject: TURIN, severity: 'warning' }),
    ])
  })

  test('suppresses skew against ineligible peers or unknown IP capacity, but honors the Galactic control-plane toleration', () => {
    const check = (peer: Node) => inspect(fixture({ nodes: list(turin, peer), pods: list(...fleet(95)) })).anomalies
    expect(check({ ...altra, spec: { ...altra.spec, unschedulable: true } })).toEqual([])
    expect(check({ ...altra, status: { conditions: [{ type: 'Ready', status: 'False' }] } })).toEqual([])
    expect(check({ ...altra, spec: { podCIDR: '10.244.4.1/25' } })).toEqual([])
    expect(check({ ...altra, spec: { ...altra.spec, taints: [{ key: 'dedicated', effect: 'NoSchedule' }] } })).toEqual(
      [],
    )
    expect(
      check({
        ...altra,
        spec: { ...altra.spec, taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] },
      }),
    ).toEqual([expect.objectContaining({ code: 'node_skew' })])
  })

  test('audits the actual Pod account, token audience, and runner mount (not a sidecar or kube-api-access)', () => {
    const report = inspect(
      fixture({
        pods: list(
          pod('default-account', { spec: { serviceAccountName: undefined } }),
          pod('overridden-account', { spec: { serviceAccountName: 'agents-sa' } }),
          pod('wrong-audience', { spec: { volumes: [projection('https://kubernetes.default.svc')] } }),
          pod('wrong-file', { spec: { volumes: [projection(AUDIENCE, 'wrong-file')] } }),
          pod('sidecar-only', {
            spec: { containers: [{ name: 'agent-runner' }, { name: 'sidecar', volumeMounts: [MOUNT] }] },
          }),
          pod('wrong-path', {
            spec: { containers: [{ name: 'agent-runner', volumeMounts: [{ ...MOUNT, mountPath: '/elsewhere' }] }] },
          }),
          pod('terminating', {
            spec: { serviceAccountName: 'default', volumes: [] },
            metadata: { deletionTimestamp: NOW },
          }),
          pod('healthy'),
        ),
      }),
    )
    expect(report.anomalies.map(({ code, subject, severity }) => [code, subject, severity])).toEqual([
      ['mcp_projection', 'agents/sidecar-only', 'critical'],
      ['mcp_projection', 'agents/wrong-audience', 'critical'],
      ['mcp_projection', 'agents/wrong-file', 'critical'],
      ['mcp_projection', 'agents/wrong-path', 'critical'],
      ['workload_identity', 'agents/default-account', 'critical'],
      ['workload_identity', 'agents/overridden-account', 'critical'],
    ])
  })

  test('compares working set to each running container limit and makes partial coverage visible', () => {
    const report = inspect(
      fixture({
        pods: list(
          pod('runner', { status: { phase: 'Running' } }),
          pod('runner', {
            metadata: { namespace: 'synthesis' },
            spec: { containers: [runner('1G')] },
            status: { phase: 'Running' },
          }),
          pod('waiting'),
          pod('no-sample', { status: { phase: 'Running' } }),
          pod('unbounded', {
            spec: { containers: [{ name: 'agent-runner', volumeMounts: [MOUNT] }] },
            status: { phase: 'Running' },
          }),
        ),
        podMetrics: list(
          metric('runner', '900Mi'),
          metric('runner', '800M', 'synthesis'),
          metric('waiting', '8Gi'),
          metric('unbounded', '2Gi'),
        ),
      }),
    )
    expect(report.memory).toEqual({ metricsAvailable: true, checkedPods: 2, runningPods: 4 })
    expect(report.anomalies).toEqual([
      expect.objectContaining({ code: 'memory_check_incomplete' }),
      {
        code: 'memory_pressure',
        severity: 'warning',
        subject: 'agents/runner',
        message: 'Container agent-runner is at 87.89% of its memory limit (943718400 / 1073741824 bytes).',
      },
    ])
  })

  test('counts terminal fleet debris in each namespace regardless of surviving AgentRun or Job', () => {
    const report = inspect(
      fixture({
        pods: list(
          pod('failed', { metadata: { namespace: 'synthesis' }, status: { phase: 'Failed', podIP: '10.244.4.8' } }),
          pod('ok', { status: { phase: 'Succeeded' } }),
          pod('host', { spec: { hostNetwork: true }, status: { phase: 'Succeeded', podIP: '10.244.4.8' } }),
          pod('unrelated', { metadata: { labels: {} }, status: { phase: 'Failed' } }),
        ),
      }),
    )
    expect(report.summary).toMatchObject({ activePods: 0, terminalPods: 3 })
    expect(report.terminalByNamespace).toEqual([
      { namespace: 'agents', succeeded: 2, failed: 0, withPodIP: 0 },
      { namespace: 'synthesis', succeeded: 0, failed: 1, withPodIP: 1 },
    ])
  })
})

const cli = fileURLToPath(new URL('../inspect-agent-fleet-health.ts', import.meta.url))
const invoke = async (directory: string, ...args: string[]) => {
  const child = Bun.spawn([process.execPath, 'run', cli, ...args], {
    env: { PATH: `${directory}:${dirname(process.execPath)}` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const withDirectory = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-fleet-health-'))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('fleet health CLI', () => {
  test('produces stable, allowlisted JSON and Markdown from fixtures and gates only with --fail-on-critical', async () => {
    await withDirectory(async (directory) => {
      const first = join(directory, 'first.json')
      const second = join(directory, 'second.json')
      const runs = [run('z-pending'), run('a-pending', { phase: 'Pending' })]
      const sensitivePod = pod('credential-example')
      const pods = [
        pod('other'),
        {
          ...sensitivePod,
          metadata: { ...sensitivePod.metadata, annotations: { example: SENSITIVE } },
          spec: {
            ...sensitivePod.spec,
            containers: [{ ...runner(), env: [{ name: 'DATABASE_URL', value: SENSITIVE }] }],
          },
          status: { phase: 'Running', message: SENSITIVE },
        },
      ]
      await Bun.write(first, JSON.stringify(fixture({ agentRuns: list(...runs), pods: list(...pods) })))
      await Bun.write(
        second,
        JSON.stringify(fixture({ agentRuns: list(...runs.toReversed()), pods: list(...pods.toReversed()) })),
      )
      const json = await invoke(directory, '--fixture', first, '--format', 'json', '--fail-on-critical')
      expect(json.exitCode).toBe(1)
      expect(json.stderr).toBe('')
      expect(json.stdout).not.toContain(SENSITIVE)
      expect(json.stdout).not.toContain('DATABASE_URL')
      expect(JSON.parse(json.stdout).summary).toMatchObject({ critical: 2, warnings: 1 })
      expect(await invoke(directory, '--fixture', second, '--format=json')).toEqual({ ...json, exitCode: 0 })

      const markdown = await invoke(directory, '--fixture', first, '--format', 'markdown')
      expect(markdown.exitCode).toBe(0)
      expect(markdown.stdout).not.toContain(SENSITIVE)
      expect(markdown.stdout).toContain('`stuck_admission` `agents/a-pending`')
      expect(markdown.stdout).toContain('Memory coverage: 0/1')
      expect(await invoke(directory, '--fixture', second)).toEqual(markdown)

      await Bun.write(first, JSON.stringify(fixture()))
      const healthy = await invoke(directory, '--fixture', first, '--fail-on-critical')
      expect(healthy.exitCode).toBe(0)
      expect(healthy.stdout).toContain('None detected.')
    })
  })

  test('rejects malformed snapshots and invalid options without echoing input or paths', async () => {
    await withDirectory(async (directory) => {
      const file = join(directory, 'invalid.json')
      await Bun.write(file, JSON.stringify({ ...fixture(), pods: SENSITIVE }))
      const malformed = await invoke(directory, '--fixture', file)
      expect(malformed).toEqual({
        exitCode: 2,
        stdout: '',
        stderr: 'Invalid fleet snapshot field: pods. See the fleet health runbook for the expected shape.\n',
      })
      const badArg = await invoke(directory, SENSITIVE)
      expect(badArg).toEqual({ exitCode: 2, stdout: '', stderr: 'Invalid arguments. Run with --help for usage.\n' })
      const missingFile = await invoke(directory, '--fixture', SENSITIVE)
      expect(missingFile).toEqual({ exitCode: 2, stdout: '', stderr: 'Could not read the fixture as JSON.\n' })
    })
  })

  test('live mode uses explicit-context GETs only and reports missing metrics without exposing kubectl stderr', async () => {
    await withDirectory(async (directory) => {
      const log = join(directory, 'calls')
      const lists = {
        '/apis/agents.proompteng.ai/v1alpha1/agentruns': list(),
        '/apis/batch/v1/jobs': list(),
        '/api/v1/pods': list(pod('runner', { status: { phase: 'Running' } })),
        '/api/v1/nodes': list(),
      }
      await writeFile(
        join(directory, 'kubectl'),
        `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const response = ${JSON.stringify(lists)}[args.at(-1).slice('--raw='.length)]
if (!response) {
  console.error(${JSON.stringify(SENSITIVE)})
  process.exit(1)
}
console.log(JSON.stringify(response))
`,
        { mode: 0o755 },
      )
      const result = await invoke(directory, '--format', 'json', '--fail-on-critical')
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const report = JSON.parse(result.stdout)
      expect(report.memory).toEqual({ metricsAvailable: false, checkedPods: 0, runningPods: 1 })
      expect(report.anomalies).toEqual([
        expect.objectContaining({ code: 'memory_check_incomplete', severity: 'warning' }),
      ])
      const calls = (await Bun.file(log).text())
        .trim()
        .split('\n')
        .sort((a, b) => a.localeCompare(b))
      const expected = [...Object.keys(lists), '/apis/metrics.k8s.io/v1beta1/pods']
        .map((path) =>
          JSON.stringify(['--context', 'galactic-tailscale', '--request-timeout=10s', 'get', `--raw=${path}`]),
        )
        .sort((a, b) => a.localeCompare(b))
      expect(calls).toEqual(expected)

      // Required reads fail closed, unlike metrics. No raw kubectl diagnostics reach the caller.
      await writeFile(
        join(directory, 'kubectl'),
        `#!/usr/bin/env bun\nconsole.error(${JSON.stringify(SENSITIVE)})\nprocess.exit(1)\n`,
      )
      const rejected = await invoke(directory)
      expect(rejected.exitCode).toBe(2)
      expect(rejected.stdout).toBe('')
      expect(rejected.stderr).toMatch(
        /^Could not read (AgentRuns|Jobs|Pods|Nodes) with kubectl on galactic-tailscale\./,
      )
      expect(rejected.stderr).not.toContain(SENSITIVE)
    })
  })
})
