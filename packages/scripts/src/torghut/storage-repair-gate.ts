#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { ensureCli, fatal } from '../shared/cli'

const GATE_SCHEMA_VERSION = 'torghut.storage-repair-gate.v1'
const RESULT_SCHEMA_VERSION = 'torghut.storage-repair-gate-result.v1'
const MINIMUM_OBSERVATION_HOURS = 24
const EXPECTED_OSD_COUNT = 6
const MAX_WAL_BYTES_PER_SECOND = 0.25 * 1024 * 1024
const MAX_CONTROLLER_EVENT_MS = 2_000
const MAX_CONTROLLER_LOG_START_DELAY_MS = 5 * 60 * 1_000
const MAX_QUORUM_FOLLOWER_LAG = 1_000
const MAX_QUORUM_FOLLOWER_LAG_TIME_MS = 5_000
const SMART_POWER_ON_HOUR_RESOLUTION_HOURS = 1
const WAL_SAMPLE_SECONDS = 30
const DEFAULT_TALOS_NODE = '100.100.244.142'
const EXPECTED_SMART_DEVICES = {
  '/dev/sda': 'ZXA12R7C',
  '/dev/sdb': 'ZXA0LKW9',
  '/dev/sdc': 'ZXA0HS7E',
} as const
const EXPECTED_ARGO_APPLICATIONS = [
  'kafka',
  'rook-ceph',
  'torghut',
  'torghut-hyperliquid-feed',
  'torghut-hyperliquid-runtime',
  'torghut-options',
] as const

type OutputFormat = 'json' | 'text'

type TimestampedEvidence = {
  timestamp: string
  message: string
}

type PodEvidence = {
  name: string
  ready: boolean
  role: 'broker' | 'controller'
  startedAt: string
}

type ControllerLogEvidence = {
  pod: string
  coverageStartedAt: string
  lines: TimestampedEvidence[]
}

type ArgoApplicationEvidence = {
  name: string
  health: string
  sync: string
}

type WorkloadEvidence = {
  name: string
  desiredReplicas: number
  actualReplicas: number
  readyReplicas: number
  availableReplicas: number
  terminatingReplicas: number
  podNames: string[]
}

type SmartDeviceEvidence = {
  device: string
  serial: string
  smartPassed: boolean
  powerOnHours: number
  extendedPollingMinutes: number
  latestExtendedSelfTest: {
    lifetimeHours: number
    passed: boolean
    status: string
  } | null
  criticalAttributes: {
    reallocatedSectors: number
    currentPendingSectors: number
    offlineUncorrectable: number
    udmaCrcErrors: number
  }
}

type RuntimeEvidence = {
  hyperliquidFeed: {
    httpOk: boolean
    status: string
    ready: boolean
    websocket: boolean
    kafka: boolean
    clickhouse: boolean
  }
  scheduler: {
    httpOk: boolean
    ok: boolean
    processRole: string
    running: boolean
    tradingSuccessIsFresh: boolean
    reconcileSuccessIsFresh: boolean
    leadership: {
      required: boolean
      acquired: boolean
      healthy: boolean
    }
  }
  knativeService: {
    generation: number
    observedGeneration: number
    ready: boolean
    latestCreatedRevision: string
    latestReadyRevision: string
    apiHttpOk: boolean
    apiStatus: string
    apiProcessRole: string
    runtimeOwner: string
  }
}

export type StorageRepairSnapshot = {
  schemaVersion: string
  capturedAt: string
  repairStartedAt: string
  talos: {
    node: string
    coverageStartedAt: string
    lines: TimestampedEvidence[]
  }
  ceph: {
    health: string
    healthChecks: string[]
    osds: {
      total: number
      up: number
      in: number
    }
    placementGroups: Array<{
      count: number
      state: string
    }>
    unacknowledgedCrashIds: string[]
  }
  smartDevices: SmartDeviceEvidence[]
  kafka: {
    ready: boolean
    generation: number
    observedGeneration: number
    kafkaVersion: string
    metadataVersion: string
    operatorVersion: string
    pods: PodEvidence[]
    unreadyTopics: string[]
    underReplicatedPartitions: string[]
    offlinePartitions: string[]
    quorum: {
      leaderId: number
      voterIds: number[]
      maxFollowerLag: number
      maxFollowerLagTimeMs: number
    }
    controllerLogs: ControllerLogEvidence[]
    controllerTimeoutOverrides: {
      electionMs: number | null
      fetchMs: number | null
    }
  }
  postgres: {
    ready: boolean
    settings: {
      fsync: string
      fullPageWrites: string
      synchronousCommit: string
      walBuffers: string
    }
    walBytesPerSecond: number
    walSampleSeconds: number
  }
  runtime: RuntimeEvidence
  workloads: WorkloadEvidence[]
  argoApplications: ArgoApplicationEvidence[]
}

export type StorageRepairGateResult = {
  schemaVersion: typeof RESULT_SCHEMA_VERSION
  ok: boolean
  capturedAt: string
  repairStartedAt: string
  observationHours: number
  failures: string[]
  warnings: string[]
  summaryLines: string[]
}

type CliOptions = {
  output: OutputFormat
  repairStartedAt?: string
  snapshotPath?: string
  talosNode: string
}

type JsonObject = Record<string, unknown>

type Incident = {
  classification: string
  message: string
  source: string
  timestamp: string
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireObject = (value: unknown, label: string): JsonObject => {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

const requireArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const requireNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

const requireBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

const parseTimestamp = (value: string, label: string): number => {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an RFC 3339 timestamp, got '${value}'`)
  return parsed
}

const rounded = (value: number, places = 3): number => Number(value.toFixed(places))

const allowedPlacementGroupState = (state: string): boolean => {
  const tokens = state.split('+')
  const allowedTokens = new Set(['active', 'clean', 'deep', 'scrubbing'])
  return tokens.includes('active') && tokens.includes('clean') && tokens.every((token) => allowedTokens.has(token))
}

const smartExtendedTestStartedAfterRepair = (smart: SmartDeviceEvidence, observationHours: number): boolean => {
  const extended = smart.latestExtendedSelfTest
  if (!extended?.passed) return false
  const completionAgeHours = smart.powerOnHours - extended.lifetimeHours
  const maximumTestDurationHours = smart.extendedPollingMinutes / 60
  return completionAgeHours + maximumTestDurationHours + SMART_POWER_ON_HOUR_RESOLUTION_HOURS <= observationHours
}

const talosFailureClass = (message: string): string | undefined => {
  if (/Power-on or device reset|host reset|COMRESET|mpt3sas.*(?:fault|reset)/i.test(message)) {
    return 'SAS transport reset'
  }
  if (/Synchronize Cache|I\/O error|blk_update_request.*error|critical target error/i.test(message)) {
    return 'durable cache-flush I/O failure'
  }
  return undefined
}

const kafkaFailureClass = (message: string): string | undefined => {
  if (
    /\[RaftManager.*(?:request timeout|timed out)|in-flight FETCH.*request timeout|Disconnecting from node .* due to request timeout/i.test(
      message,
    )
  ) {
    return 'KRaft fetch/request timeout'
  }
  if (/broker\s+\d+.*(?:was |is )?(?:fenced|fencing)|(?:fenced|fencing)\s+broker\s+\d+/i.test(message)) {
    return 'broker fencing'
  }
  return undefined
}

const controllerEventDurationMs = (message: string): number | undefined => {
  if (!/EventPerformanceMonitor|Exceptionally slow controller event/i.test(message)) return undefined
  const match = message.match(/took\s+(\d+)\s+ms/i)
  return match ? Number(match[1]) : undefined
}

const appendIncidentSummaries = (failures: string[], prefix: string, incidents: Incident[]) => {
  const grouped = Map.groupBy(incidents, ({ classification }) => classification)
  for (const [classification, entries] of grouped) {
    const ordered = entries.toSorted((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    const first = ordered[0]
    const last = ordered.at(-1)!
    const sample = first.message.length > 240 ? `${first.message.slice(0, 237)}...` : first.message
    failures.push(
      `${prefix} ${classification}: ${ordered.length} record(s); first=${first.timestamp} on ${first.source}; last=${last.timestamp}; sample=${sample}`,
    )
  }
}

const validateSnapshotShape = (snapshot: StorageRepairSnapshot) => {
  if (snapshot.schemaVersion !== GATE_SCHEMA_VERSION) {
    throw new Error(`snapshot.schemaVersion must be ${GATE_SCHEMA_VERSION}`)
  }
  parseTimestamp(requireString(snapshot.capturedAt, 'snapshot.capturedAt'), 'snapshot.capturedAt')
  parseTimestamp(requireString(snapshot.repairStartedAt, 'snapshot.repairStartedAt'), 'snapshot.repairStartedAt')
  parseTimestamp(
    requireString(snapshot.talos.coverageStartedAt, 'snapshot.talos.coverageStartedAt'),
    'snapshot.talos.coverageStartedAt',
  )
  requireString(snapshot.talos.node, 'snapshot.talos.node')
  requireNumber(snapshot.ceph.osds.total, 'snapshot.ceph.osds.total')
  requireNumber(snapshot.ceph.osds.up, 'snapshot.ceph.osds.up')
  requireNumber(snapshot.ceph.osds.in, 'snapshot.ceph.osds.in')
  requireNumber(snapshot.kafka.generation, 'snapshot.kafka.generation')
  requireNumber(snapshot.kafka.observedGeneration, 'snapshot.kafka.observedGeneration')
  requireNumber(snapshot.postgres.walBytesPerSecond, 'snapshot.postgres.walBytesPerSecond')
  requireNumber(snapshot.postgres.walSampleSeconds, 'snapshot.postgres.walSampleSeconds')
  const feed = snapshot.runtime.hyperliquidFeed
  requireBoolean(feed.httpOk, 'snapshot.runtime.hyperliquidFeed.httpOk')
  requireString(feed.status, 'snapshot.runtime.hyperliquidFeed.status')
  requireBoolean(feed.ready, 'snapshot.runtime.hyperliquidFeed.ready')
  requireBoolean(feed.websocket, 'snapshot.runtime.hyperliquidFeed.websocket')
  requireBoolean(feed.kafka, 'snapshot.runtime.hyperliquidFeed.kafka')
  requireBoolean(feed.clickhouse, 'snapshot.runtime.hyperliquidFeed.clickhouse')
  const scheduler = snapshot.runtime.scheduler
  requireBoolean(scheduler.httpOk, 'snapshot.runtime.scheduler.httpOk')
  requireBoolean(scheduler.ok, 'snapshot.runtime.scheduler.ok')
  requireString(scheduler.processRole, 'snapshot.runtime.scheduler.processRole')
  requireBoolean(scheduler.running, 'snapshot.runtime.scheduler.running')
  requireBoolean(scheduler.tradingSuccessIsFresh, 'snapshot.runtime.scheduler.tradingSuccessIsFresh')
  requireBoolean(scheduler.reconcileSuccessIsFresh, 'snapshot.runtime.scheduler.reconcileSuccessIsFresh')
  requireBoolean(scheduler.leadership.required, 'snapshot.runtime.scheduler.leadership.required')
  requireBoolean(scheduler.leadership.acquired, 'snapshot.runtime.scheduler.leadership.acquired')
  requireBoolean(scheduler.leadership.healthy, 'snapshot.runtime.scheduler.leadership.healthy')
  const knative = snapshot.runtime.knativeService
  requireNumber(knative.generation, 'snapshot.runtime.knativeService.generation')
  requireNumber(knative.observedGeneration, 'snapshot.runtime.knativeService.observedGeneration')
  requireBoolean(knative.ready, 'snapshot.runtime.knativeService.ready')
  requireString(knative.latestCreatedRevision, 'snapshot.runtime.knativeService.latestCreatedRevision')
  requireString(knative.latestReadyRevision, 'snapshot.runtime.knativeService.latestReadyRevision')
  requireBoolean(knative.apiHttpOk, 'snapshot.runtime.knativeService.apiHttpOk')
  requireString(knative.apiStatus, 'snapshot.runtime.knativeService.apiStatus')
  requireString(knative.apiProcessRole, 'snapshot.runtime.knativeService.apiProcessRole')
  requireString(knative.runtimeOwner, 'snapshot.runtime.knativeService.runtimeOwner')
  for (const [index, workload] of snapshot.workloads.entries()) {
    requireString(workload.name, `snapshot.workloads[${index}].name`)
    requireNumber(workload.desiredReplicas, `snapshot.workloads[${index}].desiredReplicas`)
    requireNumber(workload.actualReplicas, `snapshot.workloads[${index}].actualReplicas`)
    requireNumber(workload.readyReplicas, `snapshot.workloads[${index}].readyReplicas`)
    requireNumber(workload.availableReplicas, `snapshot.workloads[${index}].availableReplicas`)
    requireNumber(workload.terminatingReplicas, `snapshot.workloads[${index}].terminatingReplicas`)
    for (const [podIndex, podName] of workload.podNames.entries()) {
      requireString(podName, `snapshot.workloads[${index}].podNames[${podIndex}]`)
    }
  }
}

export const evaluateStorageRepairGate = (snapshot: StorageRepairSnapshot): StorageRepairGateResult => {
  validateSnapshotShape(snapshot)

  const failures: string[] = []
  const warnings: string[] = []
  const capturedAtMs = parseTimestamp(snapshot.capturedAt, 'snapshot.capturedAt')
  const repairStartedAtMs = parseTimestamp(snapshot.repairStartedAt, 'snapshot.repairStartedAt')
  const observationHours = (capturedAtMs - repairStartedAtMs) / 3_600_000

  if (observationHours < MINIMUM_OBSERVATION_HOURS) {
    failures.push(
      `repair observation is ${rounded(observationHours, 2)} hours; at least ${MINIMUM_OBSERVATION_HOURS} hours is required`,
    )
  }

  const talosCoverageStartedAtMs = parseTimestamp(snapshot.talos.coverageStartedAt, 'snapshot.talos.coverageStartedAt')
  if (talosCoverageStartedAtMs > repairStartedAtMs) {
    failures.push(
      `Talos dmesg starts at ${snapshot.talos.coverageStartedAt}, after repair start ${snapshot.repairStartedAt}`,
    )
  }
  const talosIncidents: Incident[] = []
  for (const line of snapshot.talos.lines) {
    const timestampMs = parseTimestamp(line.timestamp, 'Talos evidence timestamp')
    if (timestampMs < repairStartedAtMs || timestampMs > capturedAtMs) continue
    const failureClass = talosFailureClass(line.message)
    if (failureClass) {
      talosIncidents.push({
        classification: failureClass,
        message: line.message,
        source: snapshot.talos.node,
        timestamp: line.timestamp,
      })
    }
  }
  appendIncidentSummaries(failures, 'Talos', talosIncidents)

  if (snapshot.ceph.health !== 'HEALTH_OK') {
    failures.push(`Ceph health is ${snapshot.ceph.health}, expected HEALTH_OK`)
  }
  if (snapshot.ceph.healthChecks.length > 0) {
    failures.push(`Ceph health checks remain: ${snapshot.ceph.healthChecks.join(', ')}`)
  }
  if (
    snapshot.ceph.osds.total !== EXPECTED_OSD_COUNT ||
    snapshot.ceph.osds.up !== EXPECTED_OSD_COUNT ||
    snapshot.ceph.osds.in !== EXPECTED_OSD_COUNT
  ) {
    failures.push(
      `Ceph OSDs are total=${snapshot.ceph.osds.total} up=${snapshot.ceph.osds.up} in=${snapshot.ceph.osds.in}; expected ${EXPECTED_OSD_COUNT}/${EXPECTED_OSD_COUNT}/${EXPECTED_OSD_COUNT}`,
    )
  }
  const unsafePlacementGroups = snapshot.ceph.placementGroups.filter(
    ({ count, state }) => count > 0 && !allowedPlacementGroupState(state),
  )
  const placementGroupCount = snapshot.ceph.placementGroups.reduce((total, { count }) => total + count, 0)
  if (placementGroupCount <= 0) failures.push('Ceph placement-group evidence is empty')
  if (unsafePlacementGroups.length > 0) {
    failures.push(
      `Ceph has unsafe placement groups: ${unsafePlacementGroups.map(({ count, state }) => `${count} ${state}`).join(', ')}`,
    )
  }
  if (snapshot.ceph.unacknowledgedCrashIds.length > 0) {
    failures.push(`Ceph has unacknowledged crashes: ${snapshot.ceph.unacknowledgedCrashIds.join(', ')}`)
  }

  for (const [device, expectedSerial] of Object.entries(EXPECTED_SMART_DEVICES)) {
    const smart = snapshot.smartDevices.find((candidate) => candidate.device === device)
    if (!smart) {
      failures.push(`SMART evidence is missing for ${device} (${expectedSerial})`)
      continue
    }
    if (smart.serial !== expectedSerial) {
      failures.push(`SMART serial for ${device} is ${smart.serial}, expected ${expectedSerial}`)
    }
    if (!smart.smartPassed) failures.push(`SMART overall health failed for ${device} (${smart.serial})`)
    const nonZeroAttributes = Object.entries(smart.criticalAttributes).filter(([, value]) => value !== 0)
    if (nonZeroAttributes.length > 0) {
      failures.push(
        `SMART critical attributes are non-zero for ${device}: ${nonZeroAttributes.map(([name, value]) => `${name}=${value}`).join(', ')}`,
      )
    }
    const extended = smart.latestExtendedSelfTest
    if (!extended) {
      failures.push(`SMART extended self-test evidence is missing for ${device}`)
      continue
    }
    if (!extended.passed) {
      failures.push(`SMART latest extended self-test failed for ${device}: ${extended.status}`)
    }
    const hoursSinceExtendedTest = smart.powerOnHours - extended.lifetimeHours
    const maximumTestDurationHours = smart.extendedPollingMinutes / 60
    const testStartAgeUpperBoundHours =
      hoursSinceExtendedTest + maximumTestDurationHours + SMART_POWER_ON_HOUR_RESOLUTION_HOURS
    if (testStartAgeUpperBoundHours > observationHours) {
      failures.push(
        `SMART latest extended self-test for ${device} does not prove a post-repair start: completion age ${rounded(hoursSinceExtendedTest, 1)} hours + maximum duration ${rounded(maximumTestDurationHours, 2)} hours + ${SMART_POWER_ON_HOUR_RESOLUTION_HOURS} hour counter uncertainty exceeds the ${rounded(observationHours, 2)} hour repair window`,
      )
    }
  }

  if (!snapshot.kafka.ready) failures.push('Kafka Ready condition is not True')
  if (snapshot.kafka.observedGeneration !== snapshot.kafka.generation) {
    failures.push(
      `Kafka observed generation ${snapshot.kafka.observedGeneration} does not match generation ${snapshot.kafka.generation}`,
    )
  }
  if (snapshot.kafka.kafkaVersion !== '4.3.0') {
    failures.push(`Kafka version is ${snapshot.kafka.kafkaVersion}, expected 4.3.0`)
  }
  if (snapshot.kafka.metadataVersion !== '4.3-IV0') {
    failures.push(`Kafka metadata version is ${snapshot.kafka.metadataVersion}, expected 4.3-IV0`)
  }
  if (snapshot.kafka.operatorVersion !== '1.1.0') {
    failures.push(`Strimzi operator version is ${snapshot.kafka.operatorVersion}, expected 1.1.0`)
  }
  for (const role of ['controller', 'broker'] as const) {
    const pods = snapshot.kafka.pods.filter((pod) => pod.role === role)
    if (pods.length !== 3) failures.push(`Kafka has ${pods.length} ${role} pods, expected 3`)
    for (const pod of pods) {
      if (!pod.ready) failures.push(`Kafka ${role} pod ${pod.name} is not ready`)
      if (parseTimestamp(pod.startedAt, `Kafka pod ${pod.name} start`) > repairStartedAtMs) {
        failures.push(`Kafka ${role} pod ${pod.name} started after the repair observation window began`)
      }
    }
  }
  if (snapshot.kafka.unreadyTopics.length > 0) {
    failures.push(`Kafka topics are not ready: ${snapshot.kafka.unreadyTopics.join(', ')}`)
  }

  const controllerPods = new Set(snapshot.kafka.pods.filter((pod) => pod.role === 'controller').map((pod) => pod.name))
  const loggedControllerPods = new Set(snapshot.kafka.controllerLogs.map((evidence) => evidence.pod))
  for (const pod of controllerPods) {
    if (!loggedControllerPods.has(pod)) failures.push(`Kafka controller logs are missing for ${pod}`)
  }
  const kafkaIncidents: Incident[] = []
  for (const evidence of snapshot.kafka.controllerLogs) {
    const coverageStartedAtMs = parseTimestamp(
      evidence.coverageStartedAt,
      `Kafka log coverage start for ${evidence.pod}`,
    )
    if (coverageStartedAtMs > repairStartedAtMs + MAX_CONTROLLER_LOG_START_DELAY_MS) {
      failures.push(
        `Kafka controller log coverage for ${evidence.pod} starts at ${evidence.coverageStartedAt}, more than five minutes after repair start`,
      )
    }
    for (const line of evidence.lines) {
      const timestampMs = parseTimestamp(line.timestamp, `Kafka log timestamp for ${evidence.pod}`)
      if (timestampMs < repairStartedAtMs || timestampMs > capturedAtMs) continue
      const failureClass = kafkaFailureClass(line.message)
      if (failureClass) {
        kafkaIncidents.push({
          classification: failureClass,
          message: line.message,
          source: evidence.pod,
          timestamp: line.timestamp,
        })
      }
      const durationMs = controllerEventDurationMs(line.message)
      if (durationMs !== undefined && durationMs > MAX_CONTROLLER_EVENT_MS) {
        kafkaIncidents.push({
          classification: `controller event exceeded ${MAX_CONTROLLER_EVENT_MS} ms`,
          message: `${durationMs} ms: ${line.message}`,
          source: evidence.pod,
          timestamp: line.timestamp,
        })
      }
    }
  }
  appendIncidentSummaries(failures, 'Kafka', kafkaIncidents)

  const voterIds = snapshot.kafka.quorum.voterIds.toSorted((left, right) => left - right)
  if (JSON.stringify(voterIds) !== JSON.stringify([0, 1, 2])) {
    failures.push(`Kafka KRaft voters are [${voterIds.join(', ')}], expected [0, 1, 2]`)
  }
  if (!voterIds.includes(snapshot.kafka.quorum.leaderId)) {
    failures.push(`Kafka KRaft leader ${snapshot.kafka.quorum.leaderId} is not a current voter`)
  }
  if (snapshot.kafka.quorum.maxFollowerLag > MAX_QUORUM_FOLLOWER_LAG) {
    failures.push(
      `Kafka KRaft max follower lag is ${snapshot.kafka.quorum.maxFollowerLag}, limit is ${MAX_QUORUM_FOLLOWER_LAG}`,
    )
  }
  if (snapshot.kafka.quorum.maxFollowerLagTimeMs > MAX_QUORUM_FOLLOWER_LAG_TIME_MS) {
    failures.push(
      `Kafka KRaft max follower lag time is ${snapshot.kafka.quorum.maxFollowerLagTimeMs} ms, limit is ${MAX_QUORUM_FOLLOWER_LAG_TIME_MS} ms`,
    )
  }
  if (snapshot.kafka.underReplicatedPartitions.length > 0) {
    failures.push(
      `Kafka has under-replicated partitions: ${snapshot.kafka.underReplicatedPartitions.slice(0, 20).join('; ')}`,
    )
  }
  if (snapshot.kafka.offlinePartitions.length > 0) {
    failures.push(`Kafka has offline partitions: ${snapshot.kafka.offlinePartitions.slice(0, 20).join('; ')}`)
  }

  if (
    snapshot.kafka.controllerTimeoutOverrides.electionMs !== null ||
    snapshot.kafka.controllerTimeoutOverrides.fetchMs !== null
  ) {
    warnings.push(
      'Kafka controller timeout overrides remain active; this storage gate does not authorize their removal',
    )
  }

  if (!snapshot.postgres.ready) failures.push('Torghut PostgreSQL cluster is not ready')
  const postgresSettings = snapshot.postgres.settings
  if (postgresSettings.fsync !== 'on') failures.push(`PostgreSQL fsync is ${postgresSettings.fsync}, expected on`)
  if (postgresSettings.fullPageWrites !== 'on') {
    failures.push(`PostgreSQL full_page_writes is ${postgresSettings.fullPageWrites}, expected on`)
  }
  if (postgresSettings.synchronousCommit !== 'on') {
    failures.push(`PostgreSQL synchronous_commit is ${postgresSettings.synchronousCommit}, expected on`)
  }
  if (postgresSettings.walBuffers.toUpperCase() !== '16MB') {
    failures.push(`PostgreSQL wal_buffers is ${postgresSettings.walBuffers}, expected 16MB`)
  }
  if (snapshot.postgres.walSampleSeconds < WAL_SAMPLE_SECONDS) {
    failures.push(
      `PostgreSQL WAL sample is ${rounded(snapshot.postgres.walSampleSeconds, 2)} seconds; at least ${WAL_SAMPLE_SECONDS} seconds is required`,
    )
  }
  if (snapshot.postgres.walBytesPerSecond > MAX_WAL_BYTES_PER_SECOND) {
    failures.push(
      `PostgreSQL WAL rate is ${rounded(snapshot.postgres.walBytesPerSecond / 1024 / 1024, 4)} MiB/s; limit is 0.25 MiB/s`,
    )
  }

  const feed = snapshot.runtime.hyperliquidFeed
  const feedReady =
    feed.httpOk && feed.status === 'ready' && feed.ready && feed.websocket && feed.kafka && feed.clickhouse
  if (!feedReady) {
    failures.push(
      `Hyperliquid feed readiness failed: httpOk=${feed.httpOk} status=${feed.status} ready=${feed.ready} websocket=${feed.websocket} kafka=${feed.kafka} clickhouse=${feed.clickhouse}`,
    )
  }

  const scheduler = snapshot.runtime.scheduler
  const schedulerReady =
    scheduler.httpOk &&
    scheduler.ok &&
    scheduler.processRole === 'scheduler' &&
    scheduler.running &&
    scheduler.tradingSuccessIsFresh &&
    scheduler.reconcileSuccessIsFresh &&
    scheduler.leadership.required &&
    scheduler.leadership.acquired &&
    scheduler.leadership.healthy
  if (!schedulerReady) {
    failures.push(
      `Torghut scheduler readiness failed: httpOk=${scheduler.httpOk} ok=${scheduler.ok} role=${scheduler.processRole} running=${scheduler.running} tradingFresh=${scheduler.tradingSuccessIsFresh} reconcileFresh=${scheduler.reconcileSuccessIsFresh} leadership=${scheduler.leadership.required}/${scheduler.leadership.acquired}/${scheduler.leadership.healthy}`,
    )
  }

  const knative = snapshot.runtime.knativeService
  const knativeApiReady =
    knative.apiHttpOk &&
    knative.apiStatus === 'ok' &&
    knative.apiProcessRole === 'api' &&
    knative.runtimeOwner === 'torghut-scheduler'
  if (!knative.ready) failures.push('Torghut Knative Service Ready condition is not True')
  if (knative.observedGeneration !== knative.generation) {
    failures.push(
      `Torghut Knative Service observed generation ${knative.observedGeneration} does not match generation ${knative.generation}`,
    )
  }
  if (knative.latestCreatedRevision !== knative.latestReadyRevision) {
    failures.push(
      `Torghut Knative latest created revision ${knative.latestCreatedRevision} is not ready; latest ready is ${knative.latestReadyRevision}`,
    )
  }
  if (!knativeApiReady) {
    failures.push(
      `Torghut API readiness failed: httpOk=${knative.apiHttpOk} status=${knative.apiStatus} role=${knative.apiProcessRole} runtimeOwner=${knative.runtimeOwner}`,
    )
  }

  for (const expectedWorkload of ['torghut-options-archive', 'torghut-hyperliquid-clickhouse-writer']) {
    const workload = snapshot.workloads.find(({ name }) => name === expectedWorkload)
    if (!workload) {
      failures.push(`containment workload evidence is missing for ${expectedWorkload}`)
      continue
    }
    const isContained =
      workload.desiredReplicas === 0 &&
      workload.actualReplicas === 0 &&
      workload.readyReplicas === 0 &&
      workload.availableReplicas === 0 &&
      workload.terminatingReplicas === 0 &&
      workload.podNames.length === 0
    if (!isContained) {
      failures.push(
        `${expectedWorkload} must remain contained at desired=0 actual=0 ready=0 available=0 terminating=0 pods=[]; observed desired=${workload.desiredReplicas} actual=${workload.actualReplicas} ready=${workload.readyReplicas} available=${workload.availableReplicas} terminating=${workload.terminatingReplicas} pods=[${workload.podNames.join(', ')}]`,
      )
    }
  }

  for (const name of EXPECTED_ARGO_APPLICATIONS) {
    const application = snapshot.argoApplications.find((candidate) => candidate.name === name)
    if (!application) {
      failures.push(`Argo application evidence is missing for ${name}`)
      continue
    }
    if (application.sync !== 'Synced' || application.health !== 'Healthy') {
      failures.push(`Argo application ${name} is sync=${application.sync} health=${application.health}`)
    }
  }

  const uniqueFailures = [...new Set(failures)]
  const postRepairExtendedTests = snapshot.smartDevices.filter((smart) =>
    smartExtendedTestStartedAfterRepair(smart, observationHours),
  ).length
  const result: StorageRepairGateResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: uniqueFailures.length === 0,
    capturedAt: snapshot.capturedAt,
    repairStartedAt: snapshot.repairStartedAt,
    observationHours: rounded(observationHours, 3),
    failures: uniqueFailures,
    warnings,
    summaryLines: [
      `Storage repair observation: ${rounded(observationHours, 2)} hours`,
      `Ceph: ${snapshot.ceph.health}; OSDs ${snapshot.ceph.osds.up}/${snapshot.ceph.osds.in}/${snapshot.ceph.osds.total}`,
      `SMART: ${postRepairExtendedTests}/${Object.keys(EXPECTED_SMART_DEVICES).length} post-repair extended tests passed`,
      `Kafka: ${snapshot.kafka.kafkaVersion} / ${snapshot.kafka.metadataVersion}; ${snapshot.kafka.pods.filter((pod) => pod.ready).length}/${snapshot.kafka.pods.length} broker/controller pods ready`,
      `PostgreSQL WAL: ${rounded(snapshot.postgres.walBytesPerSecond / 1024 / 1024, 4)} MiB/s over ${rounded(snapshot.postgres.walSampleSeconds, 1)} seconds`,
      `Runtime: feed=${feedReady ? 'ready' : 'not-ready'} scheduler=${schedulerReady ? 'ready' : 'not-ready'} api=${knative.ready && knativeApiReady ? 'ready' : 'not-ready'} revision=${knative.latestReadyRevision}`,
      `Activation verdict: ${uniqueFailures.length === 0 ? 'PASS' : 'FAIL'}`,
    ],
  }
  return result
}

const capture = async (command: string, args: string[]): Promise<string> => {
  const subprocess = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command} ${args.join(' ')}\n${stderr.trim()}`)
  }
  return stdout.trim()
}

const captureJson = async (command: string, args: string[], label: string): Promise<unknown> => {
  const output = await capture(command, args)
  try {
    return JSON.parse(output)
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const kubectl = (args: string[]) => capture('kubectl', args)
const kubectlJson = (args: string[], label: string) => captureJson('kubectl', args, label)

const parseTalosLine = (line: string): TimestampedEvidence | undefined => {
  const match = line.match(/\[([^\]]+)\]:\s?(.*)$/)
  if (!match || !Number.isFinite(Date.parse(match[1]))) return undefined
  return { timestamp: match[1], message: match[2] }
}

const parseKubernetesLogLine = (line: string): TimestampedEvidence | undefined => {
  const separator = line.indexOf(' ')
  if (separator <= 0) return undefined
  const timestamp = line.slice(0, separator)
  if (!Number.isFinite(Date.parse(timestamp))) return undefined
  return { timestamp, message: line.slice(separator + 1) }
}

const collectTalosEvidence = async (repairStartedAt: string, node: string): Promise<StorageRepairSnapshot['talos']> => {
  const raw = await capture('talosctl', ['-n', node, 'dmesg'])
  const parsedLines = raw
    .split('\n')
    .map(parseTalosLine)
    .filter((line): line is TimestampedEvidence => Boolean(line))
  if (parsedLines.length === 0) throw new Error(`Talos dmesg returned no timestamped evidence for ${node}`)
  const repairStartedAtMs = parseTimestamp(repairStartedAt, '--repair-start')
  return {
    node,
    coverageStartedAt: parsedLines[0].timestamp,
    lines: parsedLines.filter(
      ({ timestamp }) => parseTimestamp(timestamp, 'Talos dmesg timestamp') >= repairStartedAtMs,
    ),
  }
}

const collectCephEvidence = async (): Promise<StorageRepairSnapshot['ceph']> => {
  const [statusValue, crashesValue] = await Promise.all([
    kubectlJson(
      ['-n', 'rook-ceph', 'exec', 'deploy/rook-ceph-tools', '--', 'ceph', 'status', '--format', 'json'],
      'ceph status',
    ),
    kubectlJson(
      ['-n', 'rook-ceph', 'exec', 'deploy/rook-ceph-tools', '--', 'ceph', 'crash', 'ls-new', '--format', 'json'],
      'ceph crash ls-new',
    ),
  ])
  const status = requireObject(statusValue, 'ceph status')
  const health = requireObject(status.health, 'ceph status.health')
  const checks = isObject(health.checks) ? Object.keys(health.checks) : []
  const osdMap = requireObject(status.osdmap, 'ceph status.osdmap')
  const pgMap = requireObject(status.pgmap, 'ceph status.pgmap')
  const placementGroups = requireArray(pgMap.pgs_by_state, 'ceph status.pgmap.pgs_by_state').map((value, index) => {
    const entry = requireObject(value, `ceph placement group state ${index}`)
    return {
      count: requireNumber(entry.count, `ceph placement group state ${index}.count`),
      state: requireString(entry.state_name, `ceph placement group state ${index}.state_name`),
    }
  })
  const unacknowledgedCrashIds = requireArray(crashesValue, 'ceph crash ls-new').map((value, index) => {
    const crash = requireObject(value, `ceph crash ${index}`)
    return requireString(crash.crash_id, `ceph crash ${index}.crash_id`)
  })
  return {
    health: requireString(health.status, 'ceph status.health.status'),
    healthChecks: checks,
    osds: {
      total: requireNumber(osdMap.num_osds, 'ceph status.osdmap.num_osds'),
      up: requireNumber(osdMap.num_up_osds, 'ceph status.osdmap.num_up_osds'),
      in: requireNumber(osdMap.num_in_osds, 'ceph status.osdmap.num_in_osds'),
    },
    placementGroups,
    unacknowledgedCrashIds,
  }
}

const collectSmartDeviceEvidence = async (): Promise<SmartDeviceEvidence[]> => {
  const attributeIds = {
    reallocatedSectors: 5,
    currentPendingSectors: 197,
    offlineUncorrectable: 198,
    udmaCrcErrors: 199,
  } as const
  return Promise.all(
    Object.entries(EXPECTED_SMART_DEVICES).map(async ([device, expectedSerial]) => {
      const value = await kubectlJson(
        ['-n', 'rook-ceph', 'exec', 'deploy/rook-ceph-osd-3', '-c', 'osd', '--', 'smartctl', '-a', '-j', device],
        `SMART evidence for ${device}`,
      )
      const smart = requireObject(value, `SMART evidence for ${device}`)
      const serial = requireString(smart.serial_number, `SMART ${device}.serial_number`)
      if (serial !== expectedSerial) {
        throw new Error(`SMART ${device} resolved serial ${serial}, expected ${expectedSerial}`)
      }
      const smartStatus = requireObject(smart.smart_status, `SMART ${device}.smart_status`)
      const powerOnTime = requireObject(smart.power_on_time, `SMART ${device}.power_on_time`)
      const smartData = requireObject(smart.ata_smart_data, `SMART ${device}.ata_smart_data`)
      const selfTest = requireObject(smartData.self_test, `SMART ${device}.ata_smart_data.self_test`)
      const pollingMinutes = requireObject(
        selfTest.polling_minutes,
        `SMART ${device}.ata_smart_data.self_test.polling_minutes`,
      )
      const attributes = requireArray(
        requireObject(smart.ata_smart_attributes, `SMART ${device}.ata_smart_attributes`).table,
        `SMART ${device}.ata_smart_attributes.table`,
      )
      const attributeValue = (id: number): number => {
        const attribute = attributes.find((candidate) => isObject(candidate) && candidate.id === id)
        if (!attribute || !isObject(attribute)) throw new Error(`SMART ${device} is missing attribute ${id}`)
        const raw = requireObject(attribute.raw, `SMART ${device} attribute ${id}.raw`)
        return requireNumber(raw.value, `SMART ${device} attribute ${id}.raw.value`)
      }
      const selfTestLog = requireObject(
        requireObject(smart.ata_smart_self_test_log, `SMART ${device}.ata_smart_self_test_log`).standard,
        `SMART ${device}.ata_smart_self_test_log.standard`,
      )
      const extendedEntry = requireArray(selfTestLog.table, `SMART ${device} self-test table`).find((candidate) => {
        if (!isObject(candidate) || !isObject(candidate.type)) return false
        return optionalString(candidate.type.string)?.toLowerCase().includes('extended') === true
      })
      let latestExtendedSelfTest: SmartDeviceEvidence['latestExtendedSelfTest'] = null
      if (isObject(extendedEntry)) {
        const status = requireObject(extendedEntry.status, `SMART ${device} extended self-test status`)
        latestExtendedSelfTest = {
          lifetimeHours: requireNumber(
            extendedEntry.lifetime_hours,
            `SMART ${device} extended self-test lifetime_hours`,
          ),
          passed: status.passed === true,
          status: requireString(status.string, `SMART ${device} extended self-test status.string`),
        }
      }
      return {
        device,
        serial,
        smartPassed: smartStatus.passed === true,
        powerOnHours: requireNumber(powerOnTime.hours, `SMART ${device}.power_on_time.hours`),
        extendedPollingMinutes: requireNumber(
          pollingMinutes.extended,
          `SMART ${device}.self_test.polling_minutes.extended`,
        ),
        latestExtendedSelfTest,
        criticalAttributes: Object.fromEntries(
          Object.entries(attributeIds).map(([name, id]) => [name, attributeValue(id)]),
        ) as SmartDeviceEvidence['criticalAttributes'],
      }
    }),
  )
}

const conditionIsTrue = (conditions: unknown, type: string): boolean =>
  Array.isArray(conditions) &&
  conditions.some((condition) => {
    const candidate = isObject(condition) ? condition : {}
    return candidate.type === type && candidate.status === 'True'
  })

const collectKafkaEvidence = async (repairStartedAt: string): Promise<StorageRepairSnapshot['kafka']> => {
  const [kafkaValue, podsValue, topicsValue] = await Promise.all([
    kubectlJson(['-n', 'kafka', 'get', 'kafka', 'kafka', '-o', 'json'], 'Kafka resource'),
    kubectlJson(['-n', 'kafka', 'get', 'pods', '-l', 'strimzi.io/cluster=kafka', '-o', 'json'], 'Kafka pods'),
    kubectlJson(['-n', 'kafka', 'get', 'kafkatopic', '-o', 'json'], 'Kafka topics'),
  ])
  const kafka = requireObject(kafkaValue, 'Kafka resource')
  const kafkaMetadata = requireObject(kafka.metadata, 'Kafka metadata')
  const kafkaSpec = requireObject(kafka.spec, 'Kafka spec')
  const kafkaSpecKafka = requireObject(kafkaSpec.kafka, 'Kafka spec.kafka')
  const kafkaConfig = requireObject(kafkaSpecKafka.config, 'Kafka spec.kafka.config')
  const kafkaStatus = requireObject(kafka.status, 'Kafka status')
  const podItems = requireArray(requireObject(podsValue, 'Kafka pods').items, 'Kafka pods.items')
  const pods: PodEvidence[] = []
  for (const [index, value] of podItems.entries()) {
    const pod = requireObject(value, `Kafka pod ${index}`)
    const metadata = requireObject(pod.metadata, `Kafka pod ${index}.metadata`)
    const labels = requireObject(metadata.labels, `Kafka pod ${index}.metadata.labels`)
    const poolName = optionalString(labels['strimzi.io/pool-name'])
    if (poolName !== 'pool-a' && poolName !== 'pool-b') continue
    const status = requireObject(pod.status, `Kafka pod ${index}.status`)
    const containerStatuses = requireArray(status.containerStatuses, `Kafka pod ${index}.status.containerStatuses`)
    pods.push({
      name: requireString(metadata.name, `Kafka pod ${index}.metadata.name`),
      role: poolName === 'pool-a' ? 'controller' : 'broker',
      ready:
        status.phase === 'Running' &&
        containerStatuses.length > 0 &&
        containerStatuses.every((container) => isObject(container) && container.ready === true),
      startedAt: requireString(status.startTime, `Kafka pod ${index}.status.startTime`),
    })
  }

  const topicItems = requireArray(requireObject(topicsValue, 'Kafka topics').items, 'Kafka topics.items')
  const unreadyTopics = topicItems.flatMap((value, index) => {
    const topic = requireObject(value, `Kafka topic ${index}`)
    const metadata = requireObject(topic.metadata, `Kafka topic ${index}.metadata`)
    const status = isObject(topic.status) ? topic.status : {}
    return conditionIsTrue(status.conditions, 'Ready')
      ? []
      : [requireString(metadata.name, `Kafka topic ${index}.name`)]
  })

  const controllerLogs = await Promise.all(
    pods
      .filter(({ role }) => role === 'controller')
      .map(async ({ name }) => {
        const raw = await kubectl([
          '-n',
          'kafka',
          'logs',
          name,
          '-c',
          'kafka',
          `--since-time=${repairStartedAt}`,
          '--timestamps',
        ])
        const lines = raw
          .split('\n')
          .map(parseKubernetesLogLine)
          .filter((line): line is TimestampedEvidence => Boolean(line))
        if (lines.length === 0) throw new Error(`Kafka controller ${name} returned no timestamped logs`)
        return {
          pod: name,
          coverageStartedAt: lines[0].timestamp,
          lines,
        }
      }),
  )

  const controllerPod = pods.find(({ role }) => role === 'controller')?.name
  const brokerPod = pods.find(({ role }) => role === 'broker')?.name
  if (!controllerPod || !brokerPod) throw new Error('Kafka controller and broker pods are required for quorum checks')
  const [quorumStatus, underReplicatedRaw, offlineRaw] = await Promise.all([
    kubectl([
      '-n',
      'kafka',
      'exec',
      controllerPod,
      '-c',
      'kafka',
      '--',
      '/opt/kafka/bin/kafka-metadata-quorum.sh',
      '--bootstrap-server',
      'kafka-kafka-bootstrap:9093',
      'describe',
      '--status',
    ]),
    kubectl([
      '-n',
      'kafka',
      'exec',
      brokerPod,
      '-c',
      'kafka',
      '--',
      '/opt/kafka/bin/kafka-topics.sh',
      '--bootstrap-server',
      'kafka-kafka-bootstrap:9093',
      '--describe',
      '--under-replicated-partitions',
    ]),
    kubectl([
      '-n',
      'kafka',
      'exec',
      brokerPod,
      '-c',
      'kafka',
      '--',
      '/opt/kafka/bin/kafka-topics.sh',
      '--bootstrap-server',
      'kafka-kafka-bootstrap:9093',
      '--describe',
      '--unavailable-partitions',
    ]),
  ])
  const quorumValue = (label: string): string => {
    const match = quorumStatus.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))
    if (!match) throw new Error(`Kafka quorum status is missing ${label}`)
    return match[1].trim()
  }
  const quorumNumber = (label: string): number => {
    const parsed = Number(quorumValue(label))
    if (!Number.isFinite(parsed)) throw new Error(`Kafka quorum ${label} is not numeric`)
    return parsed
  }
  const votersValue: unknown = JSON.parse(quorumValue('CurrentVoters'))
  const voterIds = requireArray(votersValue, 'Kafka CurrentVoters').map((value, index) => {
    const voter = requireObject(value, `Kafka voter ${index}`)
    return requireNumber(voter.id, `Kafka voter ${index}.id`)
  })
  const nonEmptyLines = (raw: string): string[] =>
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

  const timeoutNumber = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return null
    const parsed = typeof value === 'number' ? value : Number(value)
    const rendered = typeof value === 'string' ? value : (JSON.stringify(value) ?? typeof value)
    if (!Number.isFinite(parsed)) throw new Error(`Kafka controller timeout must be numeric, got ${rendered}`)
    return parsed
  }
  return {
    ready: conditionIsTrue(kafkaStatus.conditions, 'Ready'),
    generation: requireNumber(kafkaMetadata.generation, 'Kafka metadata.generation'),
    observedGeneration: requireNumber(kafkaStatus.observedGeneration, 'Kafka status.observedGeneration'),
    kafkaVersion: requireString(kafkaStatus.kafkaVersion, 'Kafka status.kafkaVersion'),
    metadataVersion: requireString(kafkaStatus.kafkaMetadataVersion, 'Kafka status.kafkaMetadataVersion'),
    operatorVersion: requireString(
      kafkaStatus.operatorLastSuccessfulVersion,
      'Kafka status.operatorLastSuccessfulVersion',
    ),
    pods,
    unreadyTopics,
    underReplicatedPartitions: nonEmptyLines(underReplicatedRaw),
    offlinePartitions: nonEmptyLines(offlineRaw),
    quorum: {
      leaderId: quorumNumber('LeaderId'),
      voterIds,
      maxFollowerLag: quorumNumber('MaxFollowerLag'),
      maxFollowerLagTimeMs: quorumNumber('MaxFollowerLagTimeMs'),
    },
    controllerLogs,
    controllerTimeoutOverrides: {
      electionMs: timeoutNumber(kafkaConfig['controller.quorum.election.timeout.ms']),
      fetchMs: timeoutNumber(kafkaConfig['controller.quorum.fetch.timeout.ms']),
    },
  }
}

const collectPostgresEvidence = async (): Promise<StorageRepairSnapshot['postgres']> => {
  const clusterValue = await kubectlJson(
    ['-n', 'torghut', 'get', 'cluster.postgresql.cnpg.io', 'torghut-db', '-o', 'json'],
    'Torghut PostgreSQL cluster',
  )
  const cluster = requireObject(clusterValue, 'Torghut PostgreSQL cluster')
  const status = requireObject(cluster.status, 'Torghut PostgreSQL status')
  const primary = requireString(status.currentPrimary, 'Torghut PostgreSQL status.currentPrimary')
  const psql = (sql: string) =>
    kubectl(['-n', 'torghut', 'exec', primary, '-c', 'postgres', '--', 'psql', '-At', '-F', '|', '-c', sql])
  const settingsRaw = await psql(
    "select current_setting('fsync'), current_setting('full_page_writes'), current_setting('synchronous_commit'), current_setting('wal_buffers')",
  )
  const settings = settingsRaw.split('|')
  if (settings.length !== 4) throw new Error(`PostgreSQL settings query returned ${settings.length} fields, expected 4`)

  const walPosition = async (): Promise<number> => {
    const raw = await psql("select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint")
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) throw new Error(`PostgreSQL WAL position is not numeric: '${raw}'`)
    return parsed
  }
  const firstPosition = await walPosition()
  const sampleStartedAt = Date.now()
  await Bun.sleep(WAL_SAMPLE_SECONDS * 1_000)
  const secondPosition = await walPosition()
  const sampleSeconds = (Date.now() - sampleStartedAt) / 1_000

  return {
    ready: conditionIsTrue(status.conditions, 'Ready'),
    settings: {
      fsync: settings[0],
      fullPageWrites: settings[1],
      synchronousCommit: settings[2],
      walBuffers: settings[3],
    },
    walBytesPerSecond: Math.max(0, secondPosition - firstPosition) / sampleSeconds,
    walSampleSeconds: sampleSeconds,
  }
}

const collectRuntimeEvidence = async (): Promise<RuntimeEvidence> => {
  const knativeValue = await kubectlJson(
    ['-n', 'torghut', 'get', 'services.serving.knative.dev', 'torghut', '-o', 'json'],
    'Torghut Knative Service',
  )
  const knative = requireObject(knativeValue, 'Torghut Knative Service')
  const metadata = requireObject(knative.metadata, 'Torghut Knative Service metadata')
  const status = requireObject(knative.status, 'Torghut Knative Service status')
  const latestReadyRevision = requireString(
    status.latestReadyRevisionName,
    'Torghut Knative Service status.latestReadyRevisionName',
  )

  const [feedValue, schedulerValue, apiValue] = await Promise.all([
    kubectlJson(
      ['get', '--raw', '/api/v1/namespaces/torghut/services/http:torghut-hyperliquid-feed:80/proxy/readyz'],
      'Hyperliquid feed readiness',
    ),
    kubectlJson(
      ['get', '--raw', '/api/v1/namespaces/torghut/services/http:torghut-scheduler:8183/proxy/scheduler/readyz'],
      'Torghut scheduler readiness',
    ),
    kubectlJson(
      ['get', '--raw', `/api/v1/namespaces/torghut/services/http:${latestReadyRevision}-private:80/proxy/readyz`],
      'Torghut API readiness',
    ),
  ])
  const feed = requireObject(feedValue, 'Hyperliquid feed readiness')
  const scheduler = requireObject(schedulerValue, 'Torghut scheduler readiness')
  const leadership = requireObject(scheduler.leadership, 'Torghut scheduler readiness.leadership')
  const api = requireObject(apiValue, 'Torghut API readiness')

  return {
    hyperliquidFeed: {
      httpOk: true,
      status: requireString(feed.status, 'Hyperliquid feed readiness.status'),
      ready: requireBoolean(feed.ready, 'Hyperliquid feed readiness.ready'),
      websocket: requireBoolean(feed.websocket, 'Hyperliquid feed readiness.websocket'),
      kafka: requireBoolean(feed.kafka, 'Hyperliquid feed readiness.kafka'),
      clickhouse: requireBoolean(feed.clickhouse, 'Hyperliquid feed readiness.clickhouse'),
    },
    scheduler: {
      httpOk: true,
      ok: requireBoolean(scheduler.ok, 'Torghut scheduler readiness.ok'),
      processRole: requireString(scheduler.process_role, 'Torghut scheduler readiness.process_role'),
      running: requireBoolean(scheduler.running, 'Torghut scheduler readiness.running'),
      tradingSuccessIsFresh: requireBoolean(
        scheduler.trading_success_is_fresh,
        'Torghut scheduler readiness.trading_success_is_fresh',
      ),
      reconcileSuccessIsFresh: requireBoolean(
        scheduler.reconcile_success_is_fresh,
        'Torghut scheduler readiness.reconcile_success_is_fresh',
      ),
      leadership: {
        required: requireBoolean(leadership.required, 'Torghut scheduler readiness.leadership.required'),
        acquired: requireBoolean(leadership.acquired, 'Torghut scheduler readiness.leadership.acquired'),
        healthy: requireBoolean(leadership.healthy, 'Torghut scheduler readiness.leadership.healthy'),
      },
    },
    knativeService: {
      generation: requireNumber(metadata.generation, 'Torghut Knative Service metadata.generation'),
      observedGeneration: requireNumber(status.observedGeneration, 'Torghut Knative Service status.observedGeneration'),
      ready: conditionIsTrue(status.conditions, 'Ready'),
      latestCreatedRevision: requireString(
        status.latestCreatedRevisionName,
        'Torghut Knative Service status.latestCreatedRevisionName',
      ),
      latestReadyRevision,
      apiHttpOk: true,
      apiStatus: requireString(api.status, 'Torghut API readiness.status'),
      apiProcessRole: requireString(api.process_role, 'Torghut API readiness.process_role'),
      runtimeOwner: requireString(api.runtime_owner, 'Torghut API readiness.runtime_owner'),
    },
  }
}

const collectWorkloadEvidence = async (): Promise<WorkloadEvidence[]> => {
  const [deploymentsValue, podsValue] = await Promise.all([
    kubectlJson(
      [
        '-n',
        'torghut',
        'get',
        'deployment',
        'torghut-options-archive',
        'torghut-hyperliquid-clickhouse-writer',
        '-o',
        'json',
      ],
      'contained Torghut deployments',
    ),
    kubectlJson(['-n', 'torghut', 'get', 'pods', '-o', 'json'], 'Torghut pods for containment proof'),
  ])
  const pods = requireArray(requireObject(podsValue, 'Torghut pods').items, 'pods.items').map((value, index) => {
    const pod = requireObject(value, `contained pod ${index}`)
    const metadata = requireObject(pod.metadata, `contained pod ${index}.metadata`)
    const labels = isObject(metadata.labels) ? metadata.labels : {}
    return {
      labels: Object.fromEntries(
        Object.entries(labels).flatMap(([key, labelValue]) =>
          typeof labelValue === 'string' ? [[key, labelValue]] : [],
        ),
      ),
      name: requireString(metadata.name, `contained pod ${index}.metadata.name`),
      terminating: metadata.deletionTimestamp !== undefined,
    }
  })
  return requireArray(requireObject(deploymentsValue, 'contained Torghut deployments').items, 'deployments.items').map(
    (value, index) => {
      const deployment = requireObject(value, `contained deployment ${index}`)
      const metadata = requireObject(deployment.metadata, `contained deployment ${index}.metadata`)
      const spec = requireObject(deployment.spec, `contained deployment ${index}.spec`)
      const status = isObject(deployment.status) ? deployment.status : {}
      const name = requireString(metadata.name, `contained deployment ${index}.metadata.name`)
      const selector = requireObject(spec.selector, `contained deployment ${index}.spec.selector`)
      const matchLabels = requireObject(selector.matchLabels, `contained deployment ${index}.spec.selector.matchLabels`)
      const selectorLabels = Object.entries(matchLabels).map(([key, labelValue]) => [
        key,
        requireString(labelValue, `contained deployment ${index}.spec.selector.matchLabels.${key}`),
      ])
      if (selectorLabels.length === 0) throw new Error(`contained deployment ${name} has no matchLabels selector`)
      const workloadPods = pods.filter(({ labels }) => selectorLabels.every(([key, value]) => labels[key] === value))
      const statusTerminatingReplicas =
        status.terminatingReplicas === undefined
          ? 0
          : requireNumber(status.terminatingReplicas, `deployment ${index}.terminatingReplicas`)
      return {
        name,
        desiredReplicas: requireNumber(spec.replicas, `contained deployment ${index}.spec.replicas`),
        actualReplicas:
          status.replicas === undefined ? 0 : requireNumber(status.replicas, `deployment ${index}.replicas`),
        readyReplicas:
          status.readyReplicas === undefined
            ? 0
            : requireNumber(status.readyReplicas, `deployment ${index}.readyReplicas`),
        availableReplicas:
          status.availableReplicas === undefined
            ? 0
            : requireNumber(status.availableReplicas, `deployment ${index}.availableReplicas`),
        terminatingReplicas: Math.max(
          statusTerminatingReplicas,
          workloadPods.filter(({ terminating }) => terminating).length,
        ),
        podNames: workloadPods.map(({ name: podName }) => podName).toSorted(),
      }
    },
  )
}

const collectArgoEvidence = async (): Promise<ArgoApplicationEvidence[]> => {
  const applicationsValue = await kubectlJson(
    ['-n', 'argocd', 'get', 'applications.argoproj.io', '-o', 'json'],
    'Argo applications',
  )
  const expected = new Set<string>(EXPECTED_ARGO_APPLICATIONS)
  return requireArray(requireObject(applicationsValue, 'Argo applications').items, 'Argo applications.items').flatMap(
    (value, index) => {
      const application = requireObject(value, `Argo application ${index}`)
      const metadata = requireObject(application.metadata, `Argo application ${index}.metadata`)
      const name = requireString(metadata.name, `Argo application ${index}.metadata.name`)
      if (!expected.has(name)) return []
      const status = requireObject(application.status, `Argo application ${name}.status`)
      const sync = requireObject(status.sync, `Argo application ${name}.status.sync`)
      const health = requireObject(status.health, `Argo application ${name}.status.health`)
      return [
        {
          name,
          sync: requireString(sync.status, `Argo application ${name}.status.sync.status`),
          health: requireString(health.status, `Argo application ${name}.status.health.status`),
        },
      ]
    },
  )
}

type SnapshotCollectors = {
  now: () => Date
  talos: typeof collectTalosEvidence
  ceph: typeof collectCephEvidence
  smartDevices: typeof collectSmartDeviceEvidence
  kafka: typeof collectKafkaEvidence
  postgres: typeof collectPostgresEvidence
  runtime: typeof collectRuntimeEvidence
  workloads: typeof collectWorkloadEvidence
  argoApplications: typeof collectArgoEvidence
}

const defaultSnapshotCollectors: SnapshotCollectors = {
  now: () => new Date(),
  talos: collectTalosEvidence,
  ceph: collectCephEvidence,
  smartDevices: collectSmartDeviceEvidence,
  kafka: collectKafkaEvidence,
  postgres: collectPostgresEvidence,
  runtime: collectRuntimeEvidence,
  workloads: collectWorkloadEvidence,
  argoApplications: collectArgoEvidence,
}

const collectStorageRepairSnapshotWith = async (
  repairStartedAt: string,
  talosNode: string,
  collectors: SnapshotCollectors,
): Promise<StorageRepairSnapshot> => {
  const postgres = await collectors.postgres()

  // End the claimed observation window only after the slow bounded WAL sample finishes. History collectors then read
  // through this cutoff, while every point-in-time state collector runs at or after it, eliminating a collection tail.
  const capturedAt = collectors.now().toISOString()
  const [talos, ceph, smartDevices, kafka, runtime, workloads, argoApplications] = await Promise.all([
    collectors.talos(repairStartedAt, talosNode),
    collectors.ceph(),
    collectors.smartDevices(),
    collectors.kafka(repairStartedAt),
    collectors.runtime(),
    collectors.workloads(),
    collectors.argoApplications(),
  ])
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    capturedAt,
    repairStartedAt,
    talos,
    ceph,
    smartDevices,
    kafka,
    postgres,
    runtime,
    workloads,
    argoApplications,
  }
}

export const collectStorageRepairSnapshot = async (
  repairStartedAt: string,
  talosNode = DEFAULT_TALOS_NODE,
): Promise<StorageRepairSnapshot> => {
  parseTimestamp(repairStartedAt, '--repair-start')
  ensureCli('kubectl')
  ensureCli('talosctl')
  return collectStorageRepairSnapshotWith(repairStartedAt, talosNode, defaultSnapshotCollectors)
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = { output: 'text', talosNode: DEFAULT_TALOS_NODE }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  bun run gate:torghut-storage-repair --repair-start <RFC3339> [--output text|json] [--talos-node <node>]
  bun run gate:torghut-storage-repair --snapshot <path> [--output text|json]

The live mode is read-only. It samples PostgreSQL WAL for ${WAL_SAMPLE_SECONDS} seconds and requires a complete
${MINIMUM_OBSERVATION_HOURS}-hour post-repair window. The command exits non-zero when any activation gate fails.`)
      process.exit(0)
    }
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) index += 1
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    switch (flag) {
      case '--repair-start':
        options.repairStartedAt = value
        break
      case '--snapshot':
        options.snapshotPath = value
        break
      case '--output':
        if (value !== 'json' && value !== 'text') throw new Error('--output must be text or json')
        options.output = value
        break
      case '--talos-node':
        options.talosNode = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }
  if (options.snapshotPath && options.repairStartedAt) {
    throw new Error('--snapshot and --repair-start are mutually exclusive')
  }
  if (!options.snapshotPath && !options.repairStartedAt) {
    throw new Error('live collection requires --repair-start; offline validation requires --snapshot')
  }
  return options
}

const readSnapshot = (path: string): StorageRepairSnapshot => {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read snapshot '${path}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const snapshot = requireObject(value, 'snapshot')
  return snapshot as StorageRepairSnapshot
}

const printResult = (result: StorageRepairGateResult, output: OutputFormat) => {
  if (output === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const line of result.summaryLines) console.log(line)
  for (const warning of result.warnings) console.warn(`WARN: ${warning}`)
  for (const failure of result.failures) console.error(`FAIL: ${failure}`)
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const snapshot = options.snapshotPath
    ? readSnapshot(options.snapshotPath)
    : await collectStorageRepairSnapshot(options.repairStartedAt!, options.talosNode)
  const result = evaluateStorageRepairGate(snapshot)
  printResult(result, options.output)
  if (!result.ok) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((error) => fatal('Torghut storage repair gate failed to collect or validate evidence', error))
}

export const __private = {
  collectStorageRepairSnapshotWith,
  controllerEventDurationMs,
  kafkaFailureClass,
  parseKubernetesLogLine,
  parseTalosLine,
  talosFailureClass,
}
