#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const configAnnotation = 'torghut.proompteng.ai/alloy-config-sha256'
const revisionAnnotation = 'deployment.kubernetes.io/revision'
const selector =
  '{job="torghut",namespace="torghut",service=~"torghut-ta-taskmanager-metrics|market-data-archive-taskmanager-metrics"}'
export const telemetryQueries = {
  up: `up${selector}`,
  scrapedAt: `timestamp(up${selector})`,
  samples: `scrape_samples_post_metric_relabeling${selector}`,
  exportedAt: `timestamp(flink_taskmanager_Status_JVM_Memory_Heap_Used${selector})`,
  duration: `scrape_duration_seconds${selector}`,
}
type Query = keyof typeof telemetryQueries

const at = (value: unknown, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
const array = (value: unknown, label: string): unknown[] => {
  assert(Array.isArray(value), `${label} is not an array`)
  return value
}
const text = (value: unknown, label: string): string => {
  assert(typeof value === 'string' && value.length > 0, `${label} is missing`)
  return value
}
const numeric = (value: unknown, label: string): number => {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${label} is invalid`)
  return value
}
const instant = (value: unknown, label: string): number => {
  const result = Date.parse(text(value, label)) / 1000
  assert(Number.isFinite(result), `${label} is invalid`)
  return result
}
const container = (spec: unknown, name: string): unknown => {
  const result = array(at(spec, 'containers'), 'containers').find((item) => at(item, 'name') === name)
  assert(result, `Missing container ${name}`)
  return result
}
const alive = (pods: unknown) =>
  array(at(pods, 'items'), 'Pod inventory').filter((pod) => !at(pod, 'metadata', 'deletionTimestamp'))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const immutableImage = (value: unknown): string => {
  const image = text(value, 'image')
  assert(/@sha256:[0-9a-f]{64}$/.test(image), 'Image must have an immutable digest')
  return image
}

export type TelemetryExpectation = {
  revision: string
  alloyImage: string
  alloyResources: unknown
  alloyArgs: unknown
  alloyServiceAccount: string
  alloyReplicas: number
  configHash: string
  scrapeInterval: number
  pipelines: { name: string; image: string; taskManagers: number }[]
}

export const telemetryExpectation = (
  revision: string,
  deployment: unknown,
  config: unknown,
  ta: unknown,
  archive: unknown,
): TelemetryExpectation => {
  assert(/^[0-9a-f]{40}$/.test(revision), 'Verified revision must be a full Git SHA')
  const spec = at(deployment, 'spec', 'template', 'spec')
  const alloy = container(spec, 'alloy')
  const configText = text(at(config, 'data', 'config.river'), 'promoted Alloy config')
  const configHash = hash(configText)
  assert(
    at(deployment, 'spec', 'template', 'metadata', 'annotations', configAnnotation) === configHash,
    'Promoted Alloy config and rollout digest differ',
  )
  const interval = /prometheus\.scrape "torghut"\s*\{[^}]*scrape_interval\s*=\s*"(\d+)s"/s.exec(configText)
  assert(interval, 'Promoted Torghut scrape interval is unavailable')
  const scrapeInterval = Number(interval[1])
  assert(scrapeInterval > 0 && scrapeInterval <= 60, 'Unsupported Torghut scrape interval')
  const alloyReplicas = numeric(at(deployment, 'spec', 'replicas'), 'Alloy replicas')
  assert(alloyReplicas === 1, 'The telemetry verifier requires the current single Alloy collector')
  for (const kind of ['requests', 'limits']) {
    for (const resource of ['cpu', 'memory']) text(at(alloy, 'resources', kind, resource), `Alloy ${kind} ${resource}`)
  }
  return {
    revision,
    alloyImage: immutableImage(at(alloy, 'image')),
    alloyResources: at(alloy, 'resources'),
    alloyArgs: at(alloy, 'args'),
    alloyServiceAccount: text(at(spec, 'serviceAccountName'), 'Alloy service account'),
    alloyReplicas,
    configHash,
    scrapeInterval,
    pipelines: [
      ['torghut-ta', ta],
      ['market-data-archive', archive],
    ].map(([name, manifest]) => {
      const taskManagers = numeric(at(manifest, 'spec', 'taskManager', 'replicas'), 'TaskManager replicas')
      assert(Number.isInteger(taskManagers) && taskManagers > 0, 'TaskManager replicas must be positive')
      return { name: text(name, 'pipeline name'), image: immutableImage(at(manifest, 'spec', 'image')), taskManagers }
    }),
  }
}

export type TelemetrySnapshot = {
  observedAt: number
  application: unknown
  deployment: unknown
  replicaSets: unknown
  pipelineDeployments: unknown
  pods: unknown
  mountedConfigHash: string
  remoteMetrics: string
  metrics: Record<Query, unknown>
}
type RemoteWrite = {
  processStartedAt: number
  highest: number
  sentAt: number
  sent: number
  failed: number
  retried: number
  pending: number
}
export type TelemetryObservation = {
  observedAt: number
  rolloutStartedAt: number
  alloy: { pod: string; uid: string; containerId: string; imageId: string; configHash: string; resources: unknown }
  targets: {
    service: string
    pod: string
    uid: string
    instance: string
    scrapedAt: number
    exportedAt: number
    samples: number
    duration: number
  }[]
  remoteWrite: RemoteWrite
}
export class RolloutTelemetryFailure extends Error {}

const readyPod = (pod: unknown, name: string, image: string) => {
  const podName = text(at(pod, 'metadata', 'name'), 'Pod name')
  const spec = container(at(pod, 'spec'), name)
  const status = array(at(pod, 'status', 'containerStatuses'), 'container statuses').find(
    (item) => at(item, 'name') === name,
  )
  assert(
    at(pod, 'status', 'phase') === 'Running' &&
      array(at(pod, 'status', 'conditions'), 'Pod conditions').some(
        (condition) => at(condition, 'type') === 'Ready' && at(condition, 'status') === 'True',
      ) &&
      at(status, 'ready') === true &&
      at(status, 'state', 'running'),
    `${podName} is not currently Ready`,
  )
  assert(at(spec, 'image') === image, `${podName} does not use the promoted image`)
  const imageId = text(at(status, 'imageID'), 'image ID')
  const runtimeDigest = /(?:@|^)(sha256:[0-9a-f]{64})$/.exec(imageId)?.[1]
  assert(
    runtimeDigest === /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1],
    `${podName} runtime imageID does not match the promoted index digest`,
  )
  return {
    pod: podName,
    uid: text(at(pod, 'metadata', 'uid'), 'Pod UID'),
    spec,
    status,
    startedAt: instant(at(status, 'state', 'running', 'startedAt'), 'container start'),
    containerId: text(at(status, 'containerID'), 'container ID'),
    imageId,
  }
}

const remoteWrite = (input: string): RemoteWrite => {
  const metric = (name: string, component = true) => {
    const matches = input
      .split('\n')
      .filter(
        (line) =>
          (line.startsWith(name + '{') || line.startsWith(name + ' ')) &&
          (!component || line.includes('component_id="prometheus.remote_write.mimir"')),
      )
    assert(matches.length === 1, `Missing or ambiguous Alloy metric ${name}`)
    return numeric(Number(matches[0]?.trim().split(/\s+/).at(-1)), name)
  }
  return {
    processStartedAt: metric('process_start_time_seconds', false),
    highest: metric('prometheus_remote_storage_highest_timestamp_in_seconds'),
    sentAt: metric('prometheus_remote_storage_queue_highest_sent_timestamp_seconds'),
    sent: metric('prometheus_remote_storage_samples_total'),
    failed: metric('prometheus_remote_storage_samples_failed_total'),
    retried: metric('prometheus_remote_storage_samples_retried_total'),
    pending: metric('prometheus_remote_storage_samples_pending'),
  }
}

const metricFor = (response: unknown, service: string, pod: string, instance: string): number => {
  assert(
    at(response, 'status') === 'success' && at(response, 'data', 'resultType') === 'vector',
    'Mimir did not return a successful instant vector',
  )
  const matches = array(at(response, 'data', 'result'), 'Mimir series').filter(
    (sample) =>
      at(sample, 'metric', 'service') === service &&
      at(sample, 'metric', 'pod') === pod &&
      at(sample, 'metric', 'instance') === instance,
  )
  assert(matches.length === 1, `Missing or ambiguous current target ${service}/${pod}/${instance}`)
  const value = array(at(matches[0], 'value'), 'Mimir sample')[1]
  assert(typeof value === 'string' && value.length > 0, 'Mimir sample value is missing')
  return numeric(Number(value), 'Mimir sample')
}

export const evaluateStreamingTelemetry = (
  expected: TelemetryExpectation,
  snapshot: TelemetrySnapshot,
  previous?: TelemetryObservation,
  windowStartedAt = previous?.observedAt,
): TelemetryObservation => {
  const now = numeric(snapshot.observedAt, 'Observation time')
  const operation = at(snapshot.application, 'status', 'operationState')
  assert(
    at(snapshot.application, 'status', 'sync', 'revision') === expected.revision &&
      at(operation, 'syncResult', 'revision') === expected.revision &&
      at(operation, 'phase') === 'Succeeded',
    'Argo operation no longer matches the verified revision',
  )
  const rolloutStartedAt = instant(at(operation, 'startedAt'), 'Argo rollout start')
  assert(rolloutStartedAt <= now, 'Argo rollout start is in the future')
  const deployment = snapshot.deployment
  const generation = numeric(at(deployment, 'metadata', 'generation'), 'Alloy generation')
  assert(
    numeric(at(deployment, 'status', 'observedGeneration'), 'Alloy observed generation') >= generation,
    'Alloy readiness belongs to a stale generation',
  )
  for (const key of ['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas']) {
    assert(at(deployment, 'status', key) === expected.alloyReplicas, 'Alloy rollout has not converged')
  }
  assert(at(deployment, 'spec', 'replicas') === expected.alloyReplicas, 'Alloy desired replica count drifted')
  const template = at(deployment, 'spec', 'template')
  const templateContainer = container(at(template, 'spec'), 'alloy')
  assert(
    at(templateContainer, 'image') === expected.alloyImage &&
      isDeepStrictEqual(at(templateContainer, 'resources'), expected.alloyResources) &&
      isDeepStrictEqual(at(templateContainer, 'args'), expected.alloyArgs) &&
      at(template, 'spec', 'serviceAccountName') === expected.alloyServiceAccount &&
      at(template, 'metadata', 'annotations', configAnnotation) === expected.configHash,
    'Alloy Deployment differs from promoted image/config/resources',
  )
  const deploymentUid = text(at(deployment, 'metadata', 'uid'), 'Alloy Deployment UID')
  const revision = text(at(deployment, 'metadata', 'annotations', revisionAnnotation), 'Alloy Deployment revision')
  const currentSets = array(at(snapshot.replicaSets, 'items'), 'ReplicaSet inventory').filter(
    (rs) =>
      at(rs, 'metadata', 'annotations', revisionAnnotation) === revision &&
      array(at(rs, 'metadata', 'ownerReferences'), 'ReplicaSet owners').some(
        (owner) =>
          at(owner, 'kind') === 'Deployment' && at(owner, 'uid') === deploymentUid && at(owner, 'controller') === true,
      ),
  )
  assert(currentSets.length === 1, 'Current Alloy ReplicaSet is unavailable')
  const rsUid = text(at(currentSets[0], 'metadata', 'uid'), 'ReplicaSet UID')
  const pods = alive(snapshot.pods)
  const alloyPods = pods.filter((pod) => at(pod, 'metadata', 'labels', 'app.kubernetes.io/name') === 'torghut-alloy')
  assert(alloyPods.length === expected.alloyReplicas, 'Alloy Pod rollout has not converged')
  const alloyPod = alloyPods[0]
  assert(
    array(at(alloyPod, 'metadata', 'ownerReferences'), 'Pod owners').some(
      (owner) => at(owner, 'kind') === 'ReplicaSet' && at(owner, 'uid') === rsUid && at(owner, 'controller') === true,
    ),
    'Ready Alloy Pod belongs to an old ReplicaSet',
  )
  const alloy = readyPod(alloyPod, 'alloy', expected.alloyImage)
  if (previous && (previous.alloy.uid !== alloy.uid || previous.alloy.containerId !== alloy.containerId)) {
    throw new RolloutTelemetryFailure('Alloy changed during the observation window')
  }
  const terminatedAt = at(alloy.status, 'lastState', 'terminated', 'finishedAt')
  const restarts = numeric(at(alloy.status, 'restartCount'), 'Alloy restarts')
  if (
    (terminatedAt && instant(terminatedAt, 'Alloy termination') >= rolloutStartedAt) ||
    (restarts > 0 && alloy.startedAt >= rolloutStartedAt)
  ) {
    const reason = at(alloy.status, 'lastState', 'terminated', 'reason')
    throw new RolloutTelemetryFailure(
      `Alloy restarted during this rollout (${typeof reason === 'string' ? reason : 'restart'}; pod=${alloy.pod}; uid=${alloy.uid}; restarts=${restarts})`,
    )
  }
  assert(
    isDeepStrictEqual(at(alloy.spec, 'resources'), expected.alloyResources) &&
      isDeepStrictEqual(at(alloy.spec, 'args'), expected.alloyArgs) &&
      at(alloyPod, 'spec', 'serviceAccountName') === expected.alloyServiceAccount &&
      at(alloyPod, 'metadata', 'annotations', configAnnotation) === expected.configHash &&
      snapshot.mountedConfigHash === expected.configHash,
    'Alloy Pod uses stale config/resources',
  )

  // Three configured scrape intervals allow discovery and remote-write transit, without accepting lookback-only data.
  const maximumAge = expected.scrapeInterval * 3
  const fresh = (sampleAt: number, startedAt: number, label: string) => {
    assert(
      sampleAt <= now + 5 &&
        sampleAt >= startedAt &&
        now - sampleAt <= maximumAge &&
        (windowStartedAt === undefined || sampleAt > windowStartedAt),
      `${label} is stale or predates the current process/window`,
    )
  }
  const remote = remoteWrite(snapshot.remoteMetrics)
  if (previous && previous.remoteWrite.processStartedAt !== remote.processStartedAt) {
    throw new RolloutTelemetryFailure('Alloy changed during the observation window')
  }
  if (remote.processStartedAt >= rolloutStartedAt && remote.failed > 0) {
    throw new RolloutTelemetryFailure('Alloy remote-write dropped samples during this rollout')
  }
  if (previous && (remote.failed !== previous.remoteWrite.failed || remote.sent < previous.remoteWrite.sent)) {
    throw new RolloutTelemetryFailure('Alloy remote-write dropped samples or reset during the observation window')
  }
  const targets = expected.pipelines.flatMap((pipeline) => {
    const owner = array(at(snapshot.pipelineDeployments, 'items'), 'Pipeline Deployment inventory').find(
      (item) => at(item, 'metadata', 'name') === pipeline.name,
    )
    const ownerUid = text(at(owner, 'metadata', 'uid'), 'Pipeline Deployment UID')
    assert(
      numeric(at(owner, 'status', 'observedGeneration'), 'Pipeline observed generation') >=
        numeric(at(owner, 'metadata', 'generation'), 'Pipeline generation'),
      'Pipeline Deployment readiness is stale',
    )
    assert(
      at(container(at(owner, 'spec', 'template', 'spec'), 'flink-main-container'), 'image') === pipeline.image,
      'Pipeline Deployment differs from the promoted image',
    )
    const workers = pods.filter(
      (pod) =>
        at(pod, 'metadata', 'labels', 'app') === pipeline.name &&
        at(pod, 'metadata', 'labels', 'component') === 'taskmanager' &&
        at(pod, 'metadata', 'labels', 'type') === 'flink-native-kubernetes',
    )
    assert(
      workers.length === pipeline.taskManagers,
      `${pipeline.name} current TaskManager count differs from promoted replicas`,
    )
    return workers.map((pod) => {
      assert(
        array(at(pod, 'metadata', 'ownerReferences'), 'TaskManager owners').some(
          (reference) =>
            at(reference, 'kind') === 'Deployment' &&
            at(reference, 'uid') === ownerUid &&
            at(reference, 'controller') === true,
        ),
        'TaskManager belongs to an old pipeline Deployment',
      )
      const worker = readyPod(pod, 'flink-main-container', pipeline.image)
      const ip = text(at(pod, 'status', 'podIP'), 'TaskManager Pod IP')
      const port = array(at(worker.spec, 'ports'), 'TaskManager ports').find((item) => at(item, 'name') === 'metrics')
      const instance = `${ip.includes(':') ? '[' + ip + ']' : ip}:${numeric(at(port, 'containerPort'), 'metrics port')}`
      const service = pipeline.name + '-taskmanager-metrics'
      const metric = (key: Query) => metricFor(snapshot.metrics[key], service, worker.pod, instance)
      assert(metric('up') === 1, `${worker.pod} scrape is failing`)
      const scrapedAt = metric('scrapedAt')
      const exportedAt = metric('exportedAt')
      fresh(scrapedAt, worker.startedAt, `${worker.pod} scrape`)
      fresh(exportedAt, worker.startedAt, `${worker.pod} Flink metric`)
      const samples = metric('samples')
      assert(samples > 0, `${worker.pod} has no retained scrape samples`)
      return {
        service,
        pod: worker.pod,
        uid: worker.uid,
        instance,
        scrapedAt,
        exportedAt,
        samples,
        duration: metric('duration'),
      }
    })
  })
  assert(
    remote.processStartedAt >= alloy.startedAt - 1 && remote.processStartedAt <= now + 5,
    'Alloy process identity differs from its container',
  )
  fresh(remote.sentAt, remote.processStartedAt, 'Alloy remote-write delivery')
  assert(
    remote.highest >= remote.sentAt - 1 && remote.highest - remote.sentAt <= maximumAge,
    'Alloy remote-write timestamp backlog is not converged',
  )
  if (previous) {
    assert(
      remote.sent > previous.remoteWrite.sent && remote.sentAt > previous.remoteWrite.sentAt,
      'Alloy remote-write is not making forward progress',
    )
  }
  return {
    observedAt: now,
    rolloutStartedAt,
    alloy: {
      pod: alloy.pod,
      uid: alloy.uid,
      containerId: alloy.containerId,
      imageId: alloy.imageId,
      configHash: expected.configHash,
      resources: expected.alloyResources,
    },
    targets,
    remoteWrite: remote,
  }
}

const command = async (args: string[]): Promise<string> => {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  assert(code === 0, `${args[0]} ${args[1]} failed: ${stderr.slice(0, 300)}`)
  return stdout
}
const kube = (args: string[]) => command(['kubectl', '--request-timeout=15s', ...args])
const get = async (resource: string, namespace: string, ...args: string[]): Promise<unknown> =>
  JSON.parse(await kube(['get', resource, '-n', namespace, ...args, '-o', 'json']))

export const loadTelemetryExpectation = async (revision: string): Promise<TelemetryExpectation> => {
  assert(/^[0-9a-f]{40}$/.test(revision), 'Verified revision must be a full Git SHA')
  const files = [
    'alloy-deployment.yaml',
    'alloy-configmap.yaml',
    'ta/flinkdeployment.yaml',
    'market-data-archive/flinkdeployment.yaml',
  ]
  const manifests = await Promise.all(
    files.map(async (path) =>
      Bun.YAML.parse(await command(['git', 'show', `${revision}:argocd/applications/torghut/${path}`])),
    ),
  )
  return telemetryExpectation(revision, manifests[0], manifests[1], manifests[2], manifests[3])
}

export const collectTelemetrySnapshot = async (): Promise<TelemetrySnapshot> => {
  const [application, deployment, replicaSets, pipelineDeployments, pods] = await Promise.all([
    get('application', 'argocd', 'torghut'),
    get('deployment', 'torghut', 'torghut-alloy'),
    get('replicasets', 'torghut', '-l', 'app.kubernetes.io/name=torghut-alloy'),
    get('deployments', 'torghut', 'torghut-ta', 'market-data-archive'),
    get('pods', 'torghut'),
  ])
  const alloyPods = alive(pods).filter(
    (pod) => at(pod, 'metadata', 'labels', 'app.kubernetes.io/name') === 'torghut-alloy',
  )
  assert(alloyPods.length === 1, 'Waiting for one current Alloy Pod')
  const pod = text(at(alloyPods[0], 'metadata', 'name'), 'Alloy Pod')
  const queryAt = Date.now() / 1000
  const [digest, remoteMetrics, metrics] = await Promise.all([
    kube(['exec', '-n', 'torghut', pod, '-c', 'alloy', '--', 'sha256sum', '/etc/alloy/config.river']),
    kube([
      'exec',
      '-n',
      'torghut',
      pod,
      '-c',
      'alloy',
      '--',
      'bash',
      '-c',
      "exec 3<>/dev/tcp/127.0.0.1/12345; printf 'GET /metrics HTTP/1.0\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3; grep -E '^(prometheus_remote_storage_|process_start_time_seconds)' <&3",
    ]),
    Promise.all(
      Object.entries(telemetryQueries).map(async ([key, query]) => {
        const url = new URL(
          'http://observability-mimir-gateway.observability.svc.cluster.local/prometheus/api/v1/query',
        )
        url.searchParams.set('query', query)
        url.searchParams.set('time', String(queryAt))
        const response = await fetch(url, {
          headers: { 'X-Scope-OrgID': 'anonymous' },
          signal: AbortSignal.timeout(15_000),
        })
        assert(response.ok, `Mimir ${key} returned HTTP ${response.status}`)
        return [key, await response.json()] as const
      }),
    ).then((entries) => Object.fromEntries(entries) as Record<Query, unknown>),
  ])
  const mountedConfigHash = digest.trim().split(/\s+/)[0] ?? ''
  assert(/^[0-9a-f]{64}$/.test(mountedConfigHash), 'Mounted Alloy config digest is unavailable')
  return {
    observedAt: Date.now() / 1000,
    application,
    deployment,
    replicaSets,
    pipelineDeployments,
    pods,
    mountedConfigHash,
    remoteMetrics,
    metrics,
  }
}

export const createTelemetryObservationWindow = (expected: TelemetryExpectation) => {
  let lastGood: TelemetryObservation | undefined
  let windowStartedAt: number | undefined
  return {
    observe(snapshot: TelemetrySnapshot) {
      const observation = evaluateStreamingTelemetry(expected, snapshot, lastGood, windowStartedAt)
      const complete =
        windowStartedAt !== undefined && observation.observedAt - windowStartedAt >= expected.scrapeInterval * 2
      lastGood = observation
      windowStartedAt ??= observation.observedAt
      return { observation, complete }
    },
    resetFreshnessWindow() {
      // Transient reads may restart freshness convergence, but cannot erase collector identity or dropped samples.
      windowStartedAt = undefined
    },
  }
}

const main = async () => {
  const revision = text(process.env.TORGHUT_VERIFIED_REVISION, 'TORGHUT_VERIFIED_REVISION')
  const directory = join(text(process.env.RUNNER_TEMP, 'RUNNER_TEMP'), 'torghut-post-deploy')
  await mkdir(directory, { recursive: true })
  const expected = await loadTelemetryExpectation(revision)
  const deadline = Date.now() + 300_000
  const observationWindow = createTelemetryObservationWindow(expected)
  const attempts: { observedAt: string; error?: string; observation?: TelemetryObservation }[] = []
  let complete = false
  while (Date.now() < deadline) {
    try {
      const result = observationWindow.observe(await collectTelemetrySnapshot())
      const { observation } = result
      attempts.push({ observedAt: new Date().toISOString(), observation })
      if (result.complete) {
        complete = true
        break
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Telemetry verification failed'
      attempts.push({ observedAt: new Date().toISOString(), error: message })
      console.error(message)
      observationWindow.resetFreshnessWindow()
      if (error instanceof RolloutTelemetryFailure) break
    }
    await writeFile(
      join(directory, 'streaming-telemetry.json'),
      JSON.stringify({ revision, complete, attempts }, null, 2),
    )
    const remaining = deadline - Date.now()
    if (remaining > 0) await Bun.sleep(Math.min(expected.scrapeInterval * 1000, remaining))
  }
  await writeFile(
    join(directory, 'streaming-telemetry.json'),
    JSON.stringify({ revision, complete, attempts }, null, 2),
  )
  assert(complete, 'Torghut telemetry did not pass the bounded current-rollout observation')
  console.log(
    'Torghut telemetry: promoted Alloy config/resources, current TaskManagers, and advancing Mimir delivery verified',
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Torghut telemetry verification failed')
    process.exitCode = 1
  })
}
