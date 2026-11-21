import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import {
  createTelemetryObservationWindow,
  evaluateStreamingTelemetry,
  RolloutTelemetryFailure,
  telemetryExpectation,
  telemetryQueries,
  type TelemetryExpectation,
  type TelemetrySnapshot,
} from '../verify-streaming-telemetry'

const revision = '1'.repeat(40)
const time = (value: string) => Date.parse(value) / 1000
const now = time('2026-11-21T06:20:00Z')
const startedAt = time('2026-11-21T06:07:00Z')
const iso = (value: number) => new Date(value * 1000).toISOString()
const digestAnnotation = 'torghut.proompteng.ai/alloy-config-sha256'
const revisionAnnotation = 'deployment.kubernetes.io/revision'
const resources = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } }
const manifest = (file: string) =>
  Bun.YAML.parse(readFileSync(new URL('../../../../../argocd/applications/torghut/' + file, import.meta.url), 'utf8'))

const expectation = (): TelemetryExpectation => ({
  ...telemetryExpectation(
    revision,
    manifest('alloy-deployment.yaml'),
    manifest('alloy-configmap.yaml'),
    manifest('ta/flinkdeployment.yaml'),
    manifest('market-data-archive/flinkdeployment.yaml'),
  ),
  alloyResources: structuredClone(resources),
})

const remote = (
  observedAt: number,
  overrides: Partial<{
    processStartedAt: number
    sentAt: number
    highest: number
    sent: number
    failed: number
    retried: number
    pending: number
  }> = {},
) => {
  const values = {
    processStartedAt: startedAt,
    sentAt: observedAt - 2,
    highest: observedAt - 2,
    sent: 1_000_000 + (observedAt - now) * 1_400,
    failed: 0,
    retried: 0,
    pending: 1_603,
    ...overrides,
  }
  return [
    `process_start_time_seconds ${values.processStartedAt}`,
    ...[
      ['highest_timestamp_in_seconds', values.highest],
      ['queue_highest_sent_timestamp_seconds', values.sentAt],
      ['samples_total', values.sent],
      ['samples_failed_total', values.failed],
      ['samples_retried_total', values.retried],
      ['samples_pending', values.pending],
    ].map(
      ([name, value]) =>
        `prometheus_remote_storage_${name}{component_id="prometheus.remote_write.mimir",component_path="/"} ${value}`,
    ),
  ].join('\n')
}

const fixture = (observedAt = now, expected = expectation()) => {
  const pod = (
    name: string,
    image: string,
    uid: string,
    labels: Record<string, string>,
    owner: string,
    ip: string,
  ) => ({
    metadata: {
      name,
      uid,
      labels,
      annotations: { [digestAnnotation]: expected.configHash },
      ownerReferences: [{ kind: name === 'alloy' ? 'ReplicaSet' : 'Deployment', controller: true, uid: owner }],
    },
    spec: {
      serviceAccountName: expected.alloyServiceAccount,
      containers: [
        {
          name: name === 'alloy' ? 'alloy' : 'flink-main-container',
          image,
          resources: structuredClone(expected.alloyResources),
          args: structuredClone(expected.alloyArgs),
          ports: [{ name: 'metrics', containerPort: 9249 }],
        },
      ],
    },
    status: {
      phase: 'Running',
      podIP: ip,
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name: name === 'alloy' ? 'alloy' : 'flink-main-container',
          ready: true,
          containerID: 'containerd://' + uid,
          imageID: image,
          state: { running: { startedAt: iso(startedAt) } },
          restartCount: 0,
          lastState: { terminated: undefined as { reason: string; finishedAt: string } | undefined },
        },
      ],
    },
  })
  const alloyPod = pod(
    'alloy',
    expected.alloyImage,
    'alloy-uid',
    { 'app.kubernetes.io/name': 'torghut-alloy' },
    'rs-uid',
    '10.0.0.1',
  )
  const workers = expected.pipelines.flatMap((pipeline, pipelineIndex) =>
    Array.from({ length: pipeline.taskManagers }, (_, index) =>
      pod(
        pipeline.name + '-taskmanager-1-' + (index + 1),
        pipeline.image,
        pipeline.name + '-uid-' + index,
        { app: pipeline.name, component: 'taskmanager', type: 'flink-native-kubernetes' },
        pipeline.name + '-deployment',
        `10.0.${pipelineIndex + 1}.${index + 1}`,
      ),
    ),
  )
  const pipelineDeployments = {
    items: expected.pipelines.map((pipeline) => ({
      metadata: { name: pipeline.name, uid: pipeline.name + '-deployment', generation: 3 },
      status: { observedGeneration: 3 },
      spec: { template: { spec: { containers: [{ name: 'flink-main-container', image: pipeline.image }] } } },
    })),
  }
  const metrics = Object.fromEntries(
    Object.keys(telemetryQueries).map((key) => [
      key,
      {
        status: 'success',
        data: {
          resultType: 'vector',
          result: workers.map((worker) => ({
            metric: {
              service: worker.metadata.labels.app + '-taskmanager-metrics',
              pod: worker.metadata.name,
              instance: worker.status.podIP + ':9249',
            },
            value: [
              observedAt,
              String(
                { up: 1, scrapedAt: observedAt - 10, exportedAt: observedAt - 10, samples: 3500, duration: 0.18 }[
                  key as keyof typeof telemetryQueries
                ],
              ),
            ],
          })),
        },
      },
    ]),
  ) as Record<
    keyof typeof telemetryQueries,
    {
      status: string
      data: {
        resultType: string
        result: { metric: { service: string; pod: string; instance: string }; value: (number | string)[] }[]
      }
    }
  >
  const snapshot = {
    observedAt,
    application: {
      status: {
        sync: { revision },
        operationState: {
          phase: 'Succeeded',
          startedAt: '2026-11-21T06:05:00Z',
          syncResult: { revision },
        },
      },
    },
    deployment: {
      metadata: { uid: 'deployment-uid', generation: 7, annotations: { [revisionAnnotation]: '7' } },
      status: { observedGeneration: 7, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
      spec: {
        replicas: 1,
        template: {
          metadata: { annotations: { [digestAnnotation]: expected.configHash } },
          spec: {
            serviceAccountName: expected.alloyServiceAccount,
            containers: [
              {
                name: 'alloy',
                image: expected.alloyImage,
                resources: structuredClone(expected.alloyResources),
                args: structuredClone(expected.alloyArgs),
              },
            ],
          },
        },
      },
    },
    replicaSets: {
      items: [
        {
          metadata: {
            uid: 'rs-uid',
            annotations: { [revisionAnnotation]: '7' },
            ownerReferences: [{ kind: 'Deployment', uid: 'deployment-uid', controller: true }],
          },
        },
      ],
    },
    pipelineDeployments,
    pods: { items: [alloyPod, ...workers] },
    mountedConfigHash: expected.configHash,
    remoteMetrics: remote(observedAt),
    metrics,
  } satisfies TelemetrySnapshot
  return { expected, snapshot, alloyPod, workers }
}

describe('Torghut current-rollout telemetry acceptance', () => {
  it('accepts promoted 512Mi capacity, all current worker targets, and advancing delivery with a nonzero queue', () => {
    const first = fixture()
    const prior = evaluateStreamingTelemetry(first.expected, first.snapshot)
    const next = fixture(now + 60)
    next.snapshot.remoteMetrics = remote(now + 60, { pending: 2000, retried: 20 })
    const result = evaluateStreamingTelemetry(next.expected, next.snapshot, prior)
    expect(result.targets).toHaveLength(
      next.expected.pipelines.reduce((sum, pipeline) => sum + pipeline.taskManagers, 0),
    )
    expect(result.targets.map((target) => target.instance)).toEqual(
      next.workers.map((worker) => worker.status.podIP + ':9249'),
    )
    expect(result.alloy.resources).toEqual(resources)
    expect(result.remoteWrite.sent).toBeGreaterThan(prior.remoteWrite.sent)
    expect(result.remoteWrite.pending).toBe(2000)
    expect(result.remoteWrite.retried).toBe(20)
  })

  it('derives target counts from the promoted topology', () => {
    const expected = expectation()
    expected.pipelines[0]!.taskManagers = 3
    const current = fixture(now, expected)
    expect(evaluateStreamingTelemetry(expected, current.snapshot).targets).toHaveLength(11)
  })

  it('rejects the observed Ready-after-OOM failure during the same rollout', () => {
    const current = fixture()
    const status = current.alloyPod.status.containerStatuses[0]!
    status.restartCount = 1
    status.lastState.terminated = { reason: 'OOMKilled', finishedAt: '2026-11-21T06:08:09Z' }
    status.state.running.startedAt = '2026-11-21T06:08:11Z'
    expect(() => evaluateStreamingTelemetry(current.expected, current.snapshot)).toThrow(RolloutTelemetryFailure)
    expect(() => evaluateStreamingTelemetry(current.expected, current.snapshot)).toThrow('OOMKilled')
  })

  it('rejects an in-rollout restart even when last termination details are missing', () => {
    const current = fixture()
    current.alloyPod.status.containerStatuses[0]!.restartCount = 1
    expect(() => evaluateStreamingTelemetry(current.expected, current.snapshot)).toThrow(
      'restarted during this rollout',
    )
  })

  it('does not fail a historical restart before this Argo operation', () => {
    const current = fixture()
    const status = current.alloyPod.status.containerStatuses[0]!
    status.restartCount = 1
    status.lastState.terminated = { reason: 'OOMKilled', finishedAt: '2026-11-21T05:00:00Z' }
    status.state.running.startedAt = '2026-11-21T05:00:02Z'
    current.snapshot.remoteMetrics = remote(now, { processStartedAt: time('2026-11-21T05:00:02Z') })
    expect(evaluateStreamingTelemetry(current.expected, current.snapshot).alloy.uid).toBe('alloy-uid')
  })

  for (const [name, mutate, message] of [
    [
      'stale Deployment readiness',
      (f) => {
        f.snapshot.deployment.status.observedGeneration = 6
      },
      'stale generation',
    ],
    [
      'old Ready Pod owner',
      (f) => {
        f.alloyPod.metadata.ownerReferences[0]!.uid = 'old-rs'
      },
      'old ReplicaSet',
    ],
    [
      'old Deployment resources',
      (f) => {
        f.snapshot.deployment.spec.template.spec.containers[0]!.resources = {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '256Mi' },
        }
      },
      'Deployment differs',
    ],
    [
      'old Pod resources',
      (f) => {
        f.alloyPod.spec.containers[0]!.resources = { limits: { memory: '256Mi' } }
      },
      'stale config/resources',
    ],
    [
      'old mounted config',
      (f) => {
        f.snapshot.mountedConfigHash = '0'.repeat(64)
      },
      'stale config/resources',
    ],
    [
      'old immutable Pod image',
      (f) => {
        f.alloyPod.spec.containers[0]!.image = 'registry.invalid/old@sha256:' + '0'.repeat(64)
      },
      'promoted image',
    ],
    [
      'another Argo operation',
      (f) => {
        f.snapshot.application.status.operationState.syncResult.revision = '2'.repeat(40)
      },
      'verified revision',
    ],
    [
      'old worker owner',
      (f) => {
        f.workers[0]!.metadata.ownerReferences[0]!.uid = 'old-pipeline'
      },
      'old pipeline Deployment',
    ],
    [
      'old worker image',
      (f) => {
        f.workers[0]!.spec.containers[0]!.image = 'registry.invalid/old@sha256:' + '0'.repeat(64)
      },
      'promoted image',
    ],
    [
      'missing current worker',
      (f) => {
        f.snapshot.pods.items.pop()
      },
      'TaskManager count',
    ],
    [
      'unready worker',
      (f) => {
        f.workers[0]!.status.containerStatuses[0]!.ready = false
      },
      'not currently Ready',
    ],
    [
      'missing current target',
      (f) => {
        f.snapshot.metrics.up.data.result.pop()
      },
      'Missing or ambiguous current target',
    ],
    [
      'old-only target with a reused Pod name',
      (f) => {
        f.snapshot.metrics.up.data.result[0]!.metric.instance = '10.255.0.1:9249'
      },
      'Missing or ambiguous current target',
    ],
    [
      'empty metrics',
      (f) => {
        f.snapshot.metrics.up.data.result = []
      },
      'Missing or ambiguous current target',
    ],
    [
      'failed scrape',
      (f) => {
        f.snapshot.metrics.up.data.result[0]!.value[1] = '0'
      },
      'scrape is failing',
    ],
    [
      'stale scrape',
      (f) => {
        f.snapshot.metrics.scrapedAt.data.result[0]!.value[1] = String(now - 91)
      },
      'stale or predates',
    ],
    [
      'missing native Flink metric',
      (f) => {
        f.snapshot.metrics.exportedAt.data.result.pop()
      },
      'Missing or ambiguous current target',
    ],
    [
      'stale native Flink metric with fresh up',
      (f) => {
        f.snapshot.metrics.exportedAt.data.result[0]!.value[1] = String(now - 91)
      },
      'Flink metric is stale',
    ],
    [
      'reused Pod IP with metrics from the prior process',
      (f) => {
        f.workers[0]!.status.containerStatuses[0]!.state.running.startedAt = iso(now - 5)
      },
      'predates the current process',
    ],
    [
      'no retained samples',
      (f) => {
        f.snapshot.metrics.samples.data.result[0]!.value[1] = '0'
      },
      'no retained scrape samples',
    ],
    [
      'Mimir error response',
      (f) => {
        f.snapshot.metrics.up.status = 'error'
      },
      'successful instant vector',
    ],
    [
      'missing remote-write evidence',
      (f) => {
        f.snapshot.remoteMetrics = ''
      },
      'Missing or ambiguous Alloy metric',
    ],
    [
      'stale remote delivery',
      (f) => {
        f.snapshot.remoteMetrics = remote(now, { sentAt: now - 100 })
      },
      'remote-write delivery is stale',
    ],
  ] satisfies [string, (f: ReturnType<typeof fixture>) => void, string][]) {
    it(`rejects ${name}`, () => {
      const current = fixture()
      mutate(current)
      expect(() => evaluateStreamingTelemetry(current.expected, current.snapshot)).toThrow(message)
    })
  }

  it('requires metrics to advance within the observation window rather than reusing instant-query lookback', () => {
    const first = fixture()
    const prior = evaluateStreamingTelemetry(first.expected, first.snapshot)
    const next = fixture(now + 60)
    next.snapshot.metrics.exportedAt.data.result[0]!.value[1] = String(now - 10)
    expect(() => evaluateStreamingTelemetry(next.expected, next.snapshot, prior)).toThrow('Flink metric is stale')
  })

  it('rejects remote-write drops even if Mimir remains fresh', () => {
    const first = fixture()
    const prior = evaluateStreamingTelemetry(first.expected, first.snapshot)
    const next = fixture(now + 60)
    next.snapshot.remoteMetrics = remote(now + 60, { failed: 1 })
    expect(() => evaluateStreamingTelemetry(next.expected, next.snapshot, prior)).toThrow(RolloutTelemetryFailure)
  })

  it('rejects drops before the observation when this collector started during the rollout', () => {
    const current = fixture()
    current.snapshot.remoteMetrics = remote(now, { failed: 1 })
    expect(() => evaluateStreamingTelemetry(current.expected, current.snapshot)).toThrow(
      'dropped samples during this rollout',
    )
  })

  it('rejects a stalled write queue instead of requiring an instant zero queue', () => {
    const first = fixture()
    const prior = evaluateStreamingTelemetry(first.expected, first.snapshot)
    const next = fixture(now + 60)
    next.snapshot.remoteMetrics = remote(now + 60, { sent: prior.remoteWrite.sent, pending: 50_000 })
    expect(() => evaluateStreamingTelemetry(next.expected, next.snapshot, prior)).toThrow('not making forward progress')
  })

  it('rejects a changed collector process during the window', () => {
    const first = fixture()
    const prior = evaluateStreamingTelemetry(first.expected, first.snapshot)
    const next = fixture(now + 60)
    next.snapshot.remoteMetrics = remote(now + 60, { processStartedAt: startedAt + 30 })
    expect(() => evaluateStreamingTelemetry(next.expected, next.snapshot, prior)).toThrow(
      'changed during the observation window',
    )
    expect(() => evaluateStreamingTelemetry(next.expected, next.snapshot, prior)).toThrow(RolloutTelemetryFailure)
  })

  for (const imageID of ['containerd://unresolved', 'registry.invalid/old@sha256:' + '0'.repeat(64)]) {
    it(`rejects malformed or stale runtime imageID ${imageID} despite the desired promoted image`, () => {
      const current = fixture()
      current.alloyPod.status.containerStatuses[0]!.imageID = imageID
      expect(() => evaluateStreamingTelemetry(current.expected, current.snapshot)).toThrow('runtime imageID')
    })
  }

  for (const replacement of ['pod', 'process']) {
    it(`retains collector identity through transient failure before a new ${replacement} has fresh metrics`, () => {
      const first = fixture()
      const window = createTelemetryObservationWindow(first.expected)
      expect(window.observe(first.snapshot).complete).toBe(false)
      const failed = fixture(now + 30)
      failed.snapshot.metrics.up.status = 'error'
      expect(() => window.observe(failed.snapshot)).toThrow('successful instant vector')
      window.resetFreshnessWindow()
      const next = fixture(now + 60)
      next.snapshot.metrics.up.data.result = []
      if (replacement === 'pod') next.alloyPod.metadata.uid = 'replacement-pod-uid'
      else next.snapshot.remoteMetrics = remote(now + 60, { processStartedAt: startedAt + 30 })
      expect(() => window.observe(next.snapshot)).toThrow(RolloutTelemetryFailure)
      expect(() => window.observe(next.snapshot)).toThrow('changed during the observation window')
    })
  }

  it('keeps a reused collector drop-counter baseline across collection failures', () => {
    const first = fixture()
    const oldStart = time('2026-11-21T05:00:00Z')
    first.alloyPod.status.containerStatuses[0]!.state.running.startedAt = iso(oldStart)
    first.snapshot.remoteMetrics = remote(now, { processStartedAt: oldStart, failed: 17 })
    const window = createTelemetryObservationWindow(first.expected)
    window.observe(first.snapshot)
    window.resetFreshnessWindow()
    const next = fixture(now + 60)
    next.alloyPod.status.containerStatuses[0]!.state.running.startedAt = iso(oldStart)
    next.snapshot.remoteMetrics = remote(now + 60, { processStartedAt: oldStart, failed: 18 })
    expect(() => window.observe(next.snapshot)).toThrow('dropped samples or reset')
  })

  it('rejects an observed sent-counter decrease that remains above the first observation', () => {
    const first = fixture()
    first.snapshot.remoteMetrics = remote(now, { sent: 100 })
    const window = createTelemetryObservationWindow(first.expected)
    window.observe(first.snapshot)
    const second = fixture(now + 30)
    second.snapshot.remoteMetrics = remote(now + 30, { sent: 300 })
    expect(window.observe(second.snapshot).complete).toBe(false)
    const regressed = fixture(now + 60)
    regressed.snapshot.remoteMetrics = remote(now + 60, { sent: 250 })
    expect(() => window.observe(regressed.snapshot)).toThrow('dropped samples or reset')
  })

  it('completes the normal two-interval window while retaining each last-good observation', () => {
    const first = fixture()
    const window = createTelemetryObservationWindow(first.expected)
    expect(window.observe(first.snapshot).complete).toBe(false)
    expect(window.observe(fixture(now + 30).snapshot).complete).toBe(false)
    expect(window.observe(fixture(now + 60).snapshot).complete).toBe(true)
  })

  it('restarts only the freshness window after a transient failure', () => {
    const first = fixture()
    const window = createTelemetryObservationWindow(first.expected)
    window.observe(first.snapshot)
    window.resetFreshnessWindow()
    expect(window.observe(fixture(now + 60).snapshot).complete).toBe(false)
    expect(window.observe(fixture(now + 90).snapshot).complete).toBe(false)
    expect(window.observe(fixture(now + 120).snapshot).complete).toBe(true)
  })

  it('cannot use lookback from before a restarted freshness window', () => {
    const first = fixture()
    const window = createTelemetryObservationWindow(first.expected)
    window.observe(first.snapshot)
    window.resetFreshnessWindow()
    window.observe(fixture(now + 60).snapshot)
    const stale = fixture(now + 120)
    stale.snapshot.metrics.exportedAt.data.result[0]!.value[1] = String(now + 50)
    expect(() => window.observe(stale.snapshot)).toThrow('Flink metric is stale')
  })
})
