#!/usr/bin/env bun

import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import process from 'node:process'

import { ensureCli, fatal } from '../shared/cli'

const GATE_SCHEMA_VERSION = 'torghut.storage-stability-gate.v4'
const RESULT_SCHEMA_VERSION = 'torghut.storage-stability-gate-result.v4'
const SMART_BASELINE_SCHEMA_VERSION = 'torghut.smart-baseline.v1'
const MINIMUM_OBSERVATION_MINUTES = 30
const EXPECTED_OSD_COUNT = 6
const MAX_TORGHUT_WAL_BYTES_PER_SECOND = 0.25 * 1024 * 1024
const JANGAR_WAL_BASELINE_MIB_PER_SECOND = 0.603
const MAX_JANGAR_WAL_BYTES_PER_SECOND = (JANGAR_WAL_BASELINE_MIB_PER_SECOND / 2) * 1024 * 1024
const MAX_CONTROLLER_EVENT_MS = 2_000
const MAX_CONTROLLER_LOG_START_DELAY_MS = 5 * 60 * 1_000
const MAX_QUORUM_FOLLOWER_LAG = 1_000
const MAX_QUORUM_FOLLOWER_LAG_TIME_MS = 5_000
const WAL_SAMPLE_SECONDS = 30
const DEFAULT_TALOS_NODE = '100.100.244.142'
const EXPECTED_SMART_DEVICES = {
  '/dev/sda': 'ZXA12R7C',
  '/dev/sdb': 'ZXA0LKW9',
  '/dev/sdc': 'ZXA0HS7E',
} as const
const SMART_MEDIA_ATTRIBUTE_NAMES = ['reallocatedSectors', 'currentPendingSectors', 'offlineUncorrectable'] as const
const EXPECTED_ARGO_APPLICATIONS = [
  'jangar',
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

type SmartBaselineDevice = Pick<SmartDeviceEvidence, 'criticalAttributes' | 'device' | 'serial' | 'smartPassed'>

export type SmartBaseline = {
  schemaVersion: typeof SMART_BASELINE_SCHEMA_VERSION
  capturedAt: string
  devices: SmartBaselineDevice[]
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

type PostgresEvidence = {
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

export type StorageStabilitySnapshot = {
  schemaVersion: string
  capturedAt: string
  observationStartedAt: string
  smartBaseline: SmartBaseline
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
  postgres: PostgresEvidence
  jangarPostgres: PostgresEvidence
  runtime: RuntimeEvidence
  workloads: WorkloadEvidence[]
  argoApplications: ArgoApplicationEvidence[]
}

export type StorageStabilityGateResult = {
  schemaVersion: typeof RESULT_SCHEMA_VERSION
  ok: boolean
  capturedAt: string
  observationStartedAt: string
  observationMinutes: number
  failures: string[]
  warnings: string[]
  summaryLines: string[]
}

type CliOptions = {
  captureSmartBaselinePath?: string
  output: OutputFormat
  observationStartedAt?: string
  smartBaselinePath?: string
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

const requireNonNegativeInteger = (value: unknown, label: string): number => {
  const number = requireNumber(value, label)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return number
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

const talosFailureClass = (message: string): string | undefined => {
  if (/Power-on or device reset|host reset|COMRESET|mpt3sas.*(?:fault|reset)/i.test(message)) {
    return 'SCSI device reset/recovery'
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
  if (/\bbroker\s+\d+\b.*?\b(?:fenced|fencing)\b|\b(?:fenced|fencing)\b\s+broker\s+\d+\b/i.test(message)) {
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

const validatePostgresEvidenceShape = (evidence: PostgresEvidence, label: string) => {
  requireBoolean(evidence.ready, `${label}.ready`)
  requireString(evidence.settings.fsync, `${label}.settings.fsync`)
  requireString(evidence.settings.fullPageWrites, `${label}.settings.fullPageWrites`)
  requireString(evidence.settings.synchronousCommit, `${label}.settings.synchronousCommit`)
  requireString(evidence.settings.walBuffers, `${label}.settings.walBuffers`)
  requireNumber(evidence.walBytesPerSecond, `${label}.walBytesPerSecond`)
  requireNumber(evidence.walSampleSeconds, `${label}.walSampleSeconds`)
}

const validateSmartAttributesShape = (attributes: SmartDeviceEvidence['criticalAttributes'], label: string) => {
  const value = requireObject(attributes, label)
  requireNonNegativeInteger(value.reallocatedSectors, `${label}.reallocatedSectors`)
  requireNonNegativeInteger(value.currentPendingSectors, `${label}.currentPendingSectors`)
  requireNonNegativeInteger(value.offlineUncorrectable, `${label}.offlineUncorrectable`)
  requireNonNegativeInteger(value.udmaCrcErrors, `${label}.udmaCrcErrors`)
}

const validateSmartBaselineShape = (baseline: SmartBaseline, label: string) => {
  const value = requireObject(baseline, label)
  if (value.schemaVersion !== SMART_BASELINE_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${SMART_BASELINE_SCHEMA_VERSION}`)
  }
  parseTimestamp(requireString(value.capturedAt, `${label}.capturedAt`), `${label}.capturedAt`)
  for (const [index, entry] of requireArray(value.devices, `${label}.devices`).entries()) {
    const device = requireObject(entry, `${label}.devices[${index}]`)
    requireString(device.device, `${label}.devices[${index}].device`)
    requireString(device.serial, `${label}.devices[${index}].serial`)
    requireBoolean(device.smartPassed, `${label}.devices[${index}].smartPassed`)
    validateSmartAttributesShape(
      device.criticalAttributes as SmartDeviceEvidence['criticalAttributes'],
      `${label}.devices[${index}].criticalAttributes`,
    )
  }
}

const validateSnapshotShape = (snapshot: StorageStabilitySnapshot) => {
  if (snapshot.schemaVersion !== GATE_SCHEMA_VERSION) {
    throw new Error(`snapshot.schemaVersion must be ${GATE_SCHEMA_VERSION}`)
  }
  parseTimestamp(requireString(snapshot.capturedAt, 'snapshot.capturedAt'), 'snapshot.capturedAt')
  parseTimestamp(
    requireString(snapshot.observationStartedAt, 'snapshot.observationStartedAt'),
    'snapshot.observationStartedAt',
  )
  validateSmartBaselineShape(snapshot.smartBaseline, 'snapshot.smartBaseline')
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
  for (const [index, entry] of requireArray(snapshot.smartDevices, 'snapshot.smartDevices').entries()) {
    const smart = requireObject(entry, `snapshot.smartDevices[${index}]`)
    requireString(smart.device, `snapshot.smartDevices[${index}].device`)
    requireString(smart.serial, `snapshot.smartDevices[${index}].serial`)
    requireBoolean(smart.smartPassed, `snapshot.smartDevices[${index}].smartPassed`)
    validateSmartAttributesShape(
      smart.criticalAttributes as SmartDeviceEvidence['criticalAttributes'],
      `snapshot.smartDevices[${index}].criticalAttributes`,
    )
  }
  validatePostgresEvidenceShape(snapshot.postgres, 'snapshot.postgres')
  validatePostgresEvidenceShape(snapshot.jangarPostgres, 'snapshot.jangarPostgres')
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

const appendPostgresGateFailures = (params: {
  failures: string[]
  label: string
  evidence: PostgresEvidence
  maxWalBytesPerSecond: number
  expectedWalBuffers?: string
  walLimitContext?: string
}) => {
  const { failures, label, evidence, maxWalBytesPerSecond, expectedWalBuffers, walLimitContext } = params
  const prefix = `${label} PostgreSQL`
  if (!evidence.ready) failures.push(`${prefix} cluster is not ready`)
  if (evidence.settings.fsync !== 'on') {
    failures.push(`${prefix} fsync is ${evidence.settings.fsync}, expected on`)
  }
  if (evidence.settings.fullPageWrites !== 'on') {
    failures.push(`${prefix} full_page_writes is ${evidence.settings.fullPageWrites}, expected on`)
  }
  if (evidence.settings.synchronousCommit !== 'on') {
    failures.push(`${prefix} synchronous_commit is ${evidence.settings.synchronousCommit}, expected on`)
  }
  if (expectedWalBuffers && evidence.settings.walBuffers.toUpperCase() !== expectedWalBuffers.toUpperCase()) {
    failures.push(`${prefix} wal_buffers is ${evidence.settings.walBuffers}, expected ${expectedWalBuffers}`)
  }
  if (evidence.walSampleSeconds < WAL_SAMPLE_SECONDS) {
    failures.push(
      `${prefix} WAL sample is ${rounded(evidence.walSampleSeconds, 2)} seconds; at least ${WAL_SAMPLE_SECONDS} seconds is required`,
    )
  }
  if (evidence.walBytesPerSecond > maxWalBytesPerSecond) {
    const context = walLimitContext ? ` (${walLimitContext})` : ''
    failures.push(
      `${prefix} WAL rate is ${rounded(evidence.walBytesPerSecond / 1024 / 1024, 4)} MiB/s; limit is ${rounded(maxWalBytesPerSecond / 1024 / 1024, 4)} MiB/s${context}`,
    )
  }
}

const appendSmartInventoryFailures = (
  failures: string[],
  label: string,
  devices: Array<Pick<SmartDeviceEvidence, 'device'>>,
) => {
  const counts = new Map<string, number>()
  for (const { device } of devices) counts.set(device, (counts.get(device) ?? 0) + 1)
  for (const [device, count] of counts) {
    if (!(device in EXPECTED_SMART_DEVICES)) failures.push(`${label} contains unexpected device ${device}`)
    if (count > 1) failures.push(`${label} contains ${count} records for ${device}; exactly one is required`)
  }
}

const nonZeroSmartMediaAttributes = (attributes: SmartDeviceEvidence['criticalAttributes']) =>
  SMART_MEDIA_ATTRIBUTE_NAMES.map((name) => [name, attributes[name]] as const).filter(([, value]) => value !== 0)

const smartDevicePairPasses = (
  current: SmartDeviceEvidence | undefined,
  baseline: SmartBaselineDevice | undefined,
  expectedSerial: string,
): boolean =>
  current !== undefined &&
  baseline !== undefined &&
  current.serial === expectedSerial &&
  baseline.serial === expectedSerial &&
  current.smartPassed &&
  baseline.smartPassed &&
  nonZeroSmartMediaAttributes(current.criticalAttributes).length === 0 &&
  nonZeroSmartMediaAttributes(baseline.criticalAttributes).length === 0 &&
  current.criticalAttributes.udmaCrcErrors === baseline.criticalAttributes.udmaCrcErrors

export const evaluateStorageStabilityGate = (snapshot: StorageStabilitySnapshot): StorageStabilityGateResult => {
  validateSnapshotShape(snapshot)

  const failures: string[] = []
  const warnings: string[] = []
  const capturedAtMs = parseTimestamp(snapshot.capturedAt, 'snapshot.capturedAt')
  const observationStartedAtMs = parseTimestamp(snapshot.observationStartedAt, 'snapshot.observationStartedAt')
  const smartBaselineCapturedAtMs = parseTimestamp(
    snapshot.smartBaseline.capturedAt,
    'snapshot.smartBaseline.capturedAt',
  )
  const observationMinutes = (capturedAtMs - observationStartedAtMs) / 60_000

  if (smartBaselineCapturedAtMs !== observationStartedAtMs) {
    failures.push(
      `SMART baseline was captured at ${snapshot.smartBaseline.capturedAt}; it must exactly match observation start ${snapshot.observationStartedAt}`,
    )
  }

  if (observationMinutes < MINIMUM_OBSERVATION_MINUTES) {
    failures.push(
      `storage stability observation is ${rounded(observationMinutes, 2)} minutes; at least ${MINIMUM_OBSERVATION_MINUTES} minutes is required`,
    )
  }

  const talosCoverageStartedAtMs = parseTimestamp(snapshot.talos.coverageStartedAt, 'snapshot.talos.coverageStartedAt')
  if (talosCoverageStartedAtMs > observationStartedAtMs) {
    failures.push(
      `Talos dmesg starts at ${snapshot.talos.coverageStartedAt}, after observation start ${snapshot.observationStartedAt}`,
    )
  }
  const talosIncidents: Incident[] = []
  for (const line of snapshot.talos.lines) {
    const timestampMs = parseTimestamp(line.timestamp, 'Talos evidence timestamp')
    if (timestampMs < observationStartedAtMs || timestampMs > capturedAtMs) continue
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

  appendSmartInventoryFailures(failures, 'current SMART evidence', snapshot.smartDevices)
  appendSmartInventoryFailures(failures, 'SMART baseline', snapshot.smartBaseline.devices)
  for (const [device, expectedSerial] of Object.entries(EXPECTED_SMART_DEVICES)) {
    const smart = snapshot.smartDevices.find((candidate) => candidate.device === device)
    const baseline = snapshot.smartBaseline.devices.find((candidate) => candidate.device === device)
    if (!smart) {
      failures.push(`SMART evidence is missing for ${device} (${expectedSerial})`)
    }
    if (!baseline) {
      failures.push(`SMART baseline is missing for ${device} (${expectedSerial})`)
    }
    if (smart && smart.serial !== expectedSerial) {
      failures.push(`SMART serial for ${device} is ${smart.serial}, expected ${expectedSerial}`)
    }
    if (baseline && baseline.serial !== expectedSerial) {
      failures.push(`SMART baseline serial for ${device} is ${baseline.serial}, expected ${expectedSerial}`)
    }
    if (smart && !smart.smartPassed) failures.push(`SMART overall health failed for ${device} (${smart.serial})`)
    if (baseline && !baseline.smartPassed) {
      failures.push(`SMART overall health failed at observation start for ${device} (${baseline.serial})`)
    }
    const nonZeroCurrentMediaAttributes = smart ? nonZeroSmartMediaAttributes(smart.criticalAttributes) : []
    if (nonZeroCurrentMediaAttributes.length > 0) {
      failures.push(
        `SMART media attributes are non-zero for ${device}: ${nonZeroCurrentMediaAttributes.map(([name, value]) => `${name}=${value}`).join(', ')}`,
      )
    }
    const nonZeroBaselineMediaAttributes = baseline ? nonZeroSmartMediaAttributes(baseline.criticalAttributes) : []
    if (nonZeroBaselineMediaAttributes.length > 0) {
      failures.push(
        `SMART media attributes were non-zero at observation start for ${device}: ${nonZeroBaselineMediaAttributes.map(([name, value]) => `${name}=${value}`).join(', ')}`,
      )
    }
    if (
      smart &&
      baseline &&
      smart.serial === expectedSerial &&
      baseline.serial === expectedSerial &&
      smart.criticalAttributes.udmaCrcErrors !== baseline.criticalAttributes.udmaCrcErrors
    ) {
      failures.push(
        `SMART lifetime UDMA CRC error counter changed for ${device} from ${baseline.criticalAttributes.udmaCrcErrors} at observation start to ${smart.criticalAttributes.udmaCrcErrors}`,
      )
    }
    if (smart?.latestExtendedSelfTest && !smart.latestExtendedSelfTest.passed) {
      warnings.push(
        `SMART latest extended self-test for ${device} is '${smart.latestExtendedSelfTest.status}'; this historical test is informational because current overall health and critical media/interface counters are authoritative for this gate`,
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
      if (parseTimestamp(pod.startedAt, `Kafka pod ${pod.name} start`) > observationStartedAtMs) {
        failures.push(`Kafka ${role} pod ${pod.name} started after the storage stability observation window began`)
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
    if (coverageStartedAtMs > observationStartedAtMs + MAX_CONTROLLER_LOG_START_DELAY_MS) {
      failures.push(
        `Kafka controller log coverage for ${evidence.pod} starts at ${evidence.coverageStartedAt}, more than five minutes after observation start`,
      )
    }
    for (const line of evidence.lines) {
      const timestampMs = parseTimestamp(line.timestamp, `Kafka log timestamp for ${evidence.pod}`)
      if (timestampMs < observationStartedAtMs || timestampMs > capturedAtMs) continue
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
  if (snapshot.kafka.quorum.maxFollowerLag < 0) {
    failures.push(`Kafka KRaft max follower lag is unknown (${snapshot.kafka.quorum.maxFollowerLag})`)
  } else if (snapshot.kafka.quorum.maxFollowerLag > MAX_QUORUM_FOLLOWER_LAG) {
    failures.push(
      `Kafka KRaft max follower lag is ${snapshot.kafka.quorum.maxFollowerLag}, limit is ${MAX_QUORUM_FOLLOWER_LAG}`,
    )
  }
  if (snapshot.kafka.quorum.maxFollowerLag > 0 && snapshot.kafka.quorum.maxFollowerLagTimeMs < 0) {
    failures.push(
      `Kafka KRaft max follower lag time is unknown (${snapshot.kafka.quorum.maxFollowerLagTimeMs} ms) while follower lag is ${snapshot.kafka.quorum.maxFollowerLag}`,
    )
  } else if (snapshot.kafka.quorum.maxFollowerLagTimeMs > MAX_QUORUM_FOLLOWER_LAG_TIME_MS) {
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

  appendPostgresGateFailures({
    failures,
    label: 'Torghut',
    evidence: snapshot.postgres,
    maxWalBytesPerSecond: MAX_TORGHUT_WAL_BYTES_PER_SECOND,
    expectedWalBuffers: '16MB',
  })
  appendPostgresGateFailures({
    failures,
    label: 'Jangar',
    evidence: snapshot.jangarPostgres,
    maxWalBytesPerSecond: MAX_JANGAR_WAL_BYTES_PER_SECOND,
    walLimitContext: `50% of the ${JANGAR_WAL_BASELINE_MIB_PER_SECOND} MiB/s pre-change baseline`,
  })

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

  for (const expectedWorkload of ['torghut-options-archive']) {
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
  const healthySmartDevices = Object.entries(EXPECTED_SMART_DEVICES).filter(([device, expectedSerial]) =>
    smartDevicePairPasses(
      snapshot.smartDevices.find((candidate) => candidate.device === device),
      snapshot.smartBaseline.devices.find((candidate) => candidate.device === device),
      expectedSerial,
    ),
  ).length
  const result: StorageStabilityGateResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: uniqueFailures.length === 0,
    capturedAt: snapshot.capturedAt,
    observationStartedAt: snapshot.observationStartedAt,
    observationMinutes: rounded(observationMinutes, 3),
    failures: uniqueFailures,
    warnings,
    summaryLines: [
      `Storage stability observation: ${rounded(observationMinutes, 2)} minutes`,
      `Ceph: ${snapshot.ceph.health}; OSDs ${snapshot.ceph.osds.up}/${snapshot.ceph.osds.in}/${snapshot.ceph.osds.total}`,
      `SMART: ${healthySmartDevices}/${Object.keys(EXPECTED_SMART_DEVICES).length} devices passed current/baseline health, zero-media, and no-new-CRC checks`,
      `Kafka: ${snapshot.kafka.kafkaVersion} / ${snapshot.kafka.metadataVersion}; ${snapshot.kafka.pods.filter((pod) => pod.ready).length}/${snapshot.kafka.pods.length} broker/controller pods ready`,
      `Torghut PostgreSQL WAL: ${rounded(snapshot.postgres.walBytesPerSecond / 1024 / 1024, 4)} MiB/s over ${rounded(snapshot.postgres.walSampleSeconds, 1)} seconds`,
      `Jangar PostgreSQL WAL: ${rounded(snapshot.jangarPostgres.walBytesPerSecond / 1024 / 1024, 4)} MiB/s over ${rounded(snapshot.jangarPostgres.walSampleSeconds, 1)} seconds`,
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

const collectTalosEvidence = async (
  observationStartedAt: string,
  node: string,
): Promise<StorageStabilitySnapshot['talos']> => {
  const raw = await capture('talosctl', ['-n', node, 'dmesg'])
  const parsedLines = raw
    .split('\n')
    .map(parseTalosLine)
    .filter((line): line is TimestampedEvidence => Boolean(line))
  if (parsedLines.length === 0) throw new Error(`Talos dmesg returned no timestamped evidence for ${node}`)
  const observationStartedAtMs = parseTimestamp(observationStartedAt, '--observation-start')
  return {
    node,
    coverageStartedAt: parsedLines[0].timestamp,
    lines: parsedLines.filter(
      ({ timestamp }) => parseTimestamp(timestamp, 'Talos dmesg timestamp') >= observationStartedAtMs,
    ),
  }
}

const collectCephEvidence = async (): Promise<StorageStabilitySnapshot['ceph']> => {
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
      const selfTestLog = isObject(smart.ata_smart_self_test_log) ? smart.ata_smart_self_test_log : {}
      const standardSelfTestLog = isObject(selfTestLog.standard) ? selfTestLog.standard : {}
      const selfTestTable = Array.isArray(standardSelfTestLog.table) ? standardSelfTestLog.table : []
      const extendedEntry = selfTestTable.find((candidate) => {
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
        latestExtendedSelfTest,
        criticalAttributes: Object.fromEntries(
          Object.entries(attributeIds).map(([name, id]) => [name, attributeValue(id)]),
        ) as SmartDeviceEvidence['criticalAttributes'],
      }
    }),
  )
}

const createSmartBaseline = (devices: SmartDeviceEvidence[], capturedAt: Date): SmartBaseline => ({
  schemaVersion: SMART_BASELINE_SCHEMA_VERSION,
  capturedAt: capturedAt.toISOString(),
  devices: devices.map(({ criticalAttributes, device, serial, smartPassed }) => ({
    criticalAttributes: { ...criticalAttributes },
    device,
    serial,
    smartPassed,
  })),
})

const smartBaselineCaptureFailures = (baseline: SmartBaseline): string[] => {
  validateSmartBaselineShape(baseline, 'SMART baseline')
  const failures: string[] = []
  appendSmartInventoryFailures(failures, 'SMART baseline', baseline.devices)
  for (const [device, expectedSerial] of Object.entries(EXPECTED_SMART_DEVICES)) {
    const evidence = baseline.devices.find((candidate) => candidate.device === device)
    if (!evidence) {
      failures.push(`SMART baseline is missing for ${device} (${expectedSerial})`)
      continue
    }
    if (evidence.serial !== expectedSerial) {
      failures.push(`SMART baseline serial for ${device} is ${evidence.serial}, expected ${expectedSerial}`)
    }
    if (!evidence.smartPassed) failures.push(`SMART overall health failed for ${device} (${evidence.serial})`)
    const nonZeroMediaAttributes = nonZeroSmartMediaAttributes(evidence.criticalAttributes)
    if (nonZeroMediaAttributes.length > 0) {
      failures.push(
        `SMART media attributes are non-zero for ${device}: ${nonZeroMediaAttributes.map(([name, value]) => `${name}=${value}`).join(', ')}`,
      )
    }
  }
  return [...new Set(failures)]
}

const writeSmartBaseline = (path: string, baseline: SmartBaseline) => {
  const failures = smartBaselineCaptureFailures(baseline)
  if (failures.length > 0) throw new Error(`Refusing unsafe SMART baseline: ${failures.join('; ')}`)

  let created = false
  try {
    const descriptor = openSync(path, 'wx', 0o600)
    created = true
    try {
      writeFileSync(descriptor, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (created) rmSync(path, { force: true })
    throw new Error(
      `Unable to write SMART baseline '${path}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const conditionIsTrue = (conditions: unknown, type: string): boolean =>
  Array.isArray(conditions) &&
  conditions.some((condition) => {
    const candidate = isObject(condition) ? condition : {}
    return candidate.type === type && candidate.status === 'True'
  })

const collectKafkaEvidence = async (observationStartedAt: string): Promise<StorageStabilitySnapshot['kafka']> => {
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
          `--since-time=${observationStartedAt}`,
          '--timestamps',
        ])
        const lines = raw
          .split('\n')
          .map(parseKubernetesLogLine)
          .filter((line): line is TimestampedEvidence => Boolean(line))
        return {
          pod: name,
          coverageStartedAt: observationStartedAt,
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

type PostgresCollectorDependencies = {
  cluster: () => Promise<unknown>
  psql: (primary: string, sql: string) => Promise<string>
  sleep: (milliseconds: number) => Promise<unknown>
  now: () => number
}

const buildDefaultPostgresCollectorDependencies = (params: {
  namespace: string
  clusterName: string
  label: string
}): PostgresCollectorDependencies => ({
  cluster: () =>
    kubectlJson(
      ['-n', params.namespace, 'get', 'cluster.postgresql.cnpg.io', params.clusterName, '-o', 'json'],
      `${params.label} PostgreSQL cluster`,
    ),
  psql: (primary, sql) =>
    kubectl(['-n', params.namespace, 'exec', primary, '-c', 'postgres', '--', 'psql', '-At', '-F', '|', '-c', sql]),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  now: () => Date.now(),
})

const defaultPostgresCollectorDependencies = (): PostgresCollectorDependencies =>
  buildDefaultPostgresCollectorDependencies({ namespace: 'torghut', clusterName: 'torghut-db', label: 'Torghut' })

const defaultJangarPostgresCollectorDependencies = (): PostgresCollectorDependencies =>
  buildDefaultPostgresCollectorDependencies({ namespace: 'jangar', clusterName: 'jangar-db', label: 'Jangar' })

const collectPostgresEvidenceFor = async (
  label: string,
  dependencies: PostgresCollectorDependencies,
): Promise<PostgresEvidence> => {
  const initialCluster = requireObject(await dependencies.cluster(), `initial ${label} PostgreSQL cluster`)
  const initialStatus = requireObject(initialCluster.status, `initial ${label} PostgreSQL status`)
  const initialPrimary = requireString(
    initialStatus.currentPrimary,
    `initial ${label} PostgreSQL status.currentPrimary`,
  )
  const walPosition = async (primary: string): Promise<number> => {
    const raw = await dependencies.psql(primary, "select pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint")
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) throw new Error(`${label} PostgreSQL WAL position is not numeric: '${raw}'`)
    return parsed
  }
  const firstPosition = await walPosition(initialPrimary)
  const sampleStartedAt = dependencies.now()
  await dependencies.sleep(WAL_SAMPLE_SECONDS * 1_000)

  const finalCluster = requireObject(await dependencies.cluster(), `final ${label} PostgreSQL cluster`)
  const finalStatus = requireObject(finalCluster.status, `final ${label} PostgreSQL status`)
  const finalPrimary = requireString(finalStatus.currentPrimary, `final ${label} PostgreSQL status.currentPrimary`)
  const [secondPosition, settingsRaw] = await Promise.all([
    walPosition(finalPrimary),
    dependencies.psql(
      finalPrimary,
      "select current_setting('fsync'), current_setting('full_page_writes'), current_setting('synchronous_commit'), current_setting('wal_buffers')",
    ),
  ])
  if (secondPosition < firstPosition) {
    throw new Error(`${label} PostgreSQL WAL position moved backwards from ${firstPosition} to ${secondPosition}`)
  }
  const sampleSeconds = (dependencies.now() - sampleStartedAt) / 1_000
  const settings = settingsRaw.split('|')
  if (settings.length !== 4) {
    throw new Error(`${label} PostgreSQL settings query returned ${settings.length} fields, expected 4`)
  }

  return {
    ready: conditionIsTrue(finalStatus.conditions, 'Ready'),
    settings: {
      fsync: settings[0],
      fullPageWrites: settings[1],
      synchronousCommit: settings[2],
      walBuffers: settings[3],
    },
    walBytesPerSecond: (secondPosition - firstPosition) / sampleSeconds,
    walSampleSeconds: sampleSeconds,
  }
}

const collectPostgresEvidence = async (
  dependencies: PostgresCollectorDependencies = defaultPostgresCollectorDependencies(),
): Promise<StorageStabilitySnapshot['postgres']> => collectPostgresEvidenceFor('Torghut', dependencies)

const collectJangarPostgresEvidence = async (
  dependencies: PostgresCollectorDependencies = defaultJangarPostgresCollectorDependencies(),
): Promise<StorageStabilitySnapshot['jangarPostgres']> => collectPostgresEvidenceFor('Jangar', dependencies)

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

const containedWorkloadNames = new Set(['torghut-options-archive'])

const collectWorkloadEvidenceFromValues = (deploymentsValue: unknown, podsValue: unknown): WorkloadEvidence[] => {
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
  const deployments = requireArray(
    requireObject(deploymentsValue, 'contained Torghut deployments').items,
    'deployments.items',
  ).flatMap((value, index) => {
    const deployment = requireObject(value, `contained deployment candidate ${index}`)
    const metadata = requireObject(deployment.metadata, `contained deployment candidate ${index}.metadata`)
    const name = requireString(metadata.name, `contained deployment candidate ${index}.metadata.name`)
    return containedWorkloadNames.has(name) ? [{ deployment, index, name }] : []
  })
  return deployments.map(({ deployment, index, name }) => {
    const spec = requireObject(deployment.spec, `contained deployment ${index}.spec`)
    const status = isObject(deployment.status) ? deployment.status : {}
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
  })
}

const collectWorkloadEvidence = async (): Promise<WorkloadEvidence[]> => {
  const [deploymentsValue, podsValue] = await Promise.all([
    kubectlJson(['-n', 'torghut', 'get', 'deployment', '-o', 'json'], 'contained Torghut deployments'),
    kubectlJson(['-n', 'torghut', 'get', 'pods', '-o', 'json'], 'Torghut pods for containment proof'),
  ])
  return collectWorkloadEvidenceFromValues(deploymentsValue, podsValue)
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
  jangarPostgres: typeof collectJangarPostgresEvidence
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
  jangarPostgres: collectJangarPostgresEvidence,
  runtime: collectRuntimeEvidence,
  workloads: collectWorkloadEvidence,
  argoApplications: collectArgoEvidence,
}

const collectStorageStabilitySnapshotWith = async (
  observationStartedAt: string,
  talosNode: string,
  smartBaseline: SmartBaseline,
  collectors: SnapshotCollectors,
): Promise<StorageStabilitySnapshot> => {
  const [postgres, jangarPostgres] = await Promise.all([collectors.postgres(), collectors.jangarPostgres()])

  // End the claimed observation window only after the slow bounded WAL sample finishes. History collectors then read
  // through this cutoff, while every point-in-time state collector runs at or after it, eliminating a collection tail.
  const capturedAt = collectors.now().toISOString()
  const [talos, ceph, smartDevices, kafka, runtime, workloads, argoApplications] = await Promise.all([
    collectors.talos(observationStartedAt, talosNode),
    collectors.ceph(),
    collectors.smartDevices(),
    collectors.kafka(observationStartedAt),
    collectors.runtime(),
    collectors.workloads(),
    collectors.argoApplications(),
  ])
  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    capturedAt,
    observationStartedAt,
    smartBaseline,
    talos,
    ceph,
    smartDevices,
    kafka,
    postgres,
    jangarPostgres,
    runtime,
    workloads,
    argoApplications,
  }
}

export const collectStorageStabilitySnapshot = async (
  observationStartedAt: string,
  smartBaseline: SmartBaseline,
  talosNode = DEFAULT_TALOS_NODE,
): Promise<StorageStabilitySnapshot> => {
  const observationStartedAtMs = parseTimestamp(observationStartedAt, '--observation-start')
  const baselineFailures = smartBaselineCaptureFailures(smartBaseline)
  if (baselineFailures.length > 0) {
    throw new Error(`SMART baseline is not safe for observation: ${baselineFailures.join('; ')}`)
  }
  if (parseTimestamp(smartBaseline.capturedAt, 'SMART baseline.capturedAt') !== observationStartedAtMs) {
    throw new Error(
      `SMART baseline was captured at ${smartBaseline.capturedAt}; it must exactly match --observation-start ${observationStartedAt}`,
    )
  }
  ensureCli('kubectl')
  ensureCli('talosctl')
  return collectStorageStabilitySnapshotWith(observationStartedAt, talosNode, smartBaseline, defaultSnapshotCollectors)
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = { output: 'text', talosNode: DEFAULT_TALOS_NODE }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  bun run gate:torghut-storage-stability --capture-smart-baseline <path> [--output text|json]
  bun run gate:torghut-storage-stability --observation-start <RFC3339> --smart-baseline <path> [--output text|json] [--talos-node <node>]
  bun run gate:torghut-storage-stability --snapshot <path> [--output text|json]

Capture mode reads current SMART data and writes a new local baseline file without mutating the cluster. Use the emitted
capture timestamp as --observation-start. Live gate mode is read-only, samples Torghut and Jangar PostgreSQL WAL concurrently
for ${WAL_SAMPLE_SECONDS} seconds, and requires a complete ${MINIMUM_OBSERVATION_MINUTES}-minute clean observation window. The command exits non-zero
when any activation gate fails.`)
      process.exit(0)
    }
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) index += 1
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    switch (flag) {
      case '--capture-smart-baseline':
        options.captureSmartBaselinePath = value
        break
      case '--observation-start':
        options.observationStartedAt = value
        break
      case '--smart-baseline':
        options.smartBaselinePath = value
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
  const modeCount = [options.captureSmartBaselinePath, options.observationStartedAt, options.snapshotPath].filter(
    Boolean,
  ).length
  if (modeCount !== 1) {
    throw new Error('select exactly one mode: --capture-smart-baseline, --observation-start, or --snapshot')
  }
  if (options.observationStartedAt && !options.smartBaselinePath) {
    throw new Error('live collection requires --smart-baseline captured at --observation-start')
  }
  if (options.smartBaselinePath && !options.observationStartedAt) {
    throw new Error('--smart-baseline requires --observation-start')
  }
  return options
}

const readSnapshot = (path: string): StorageStabilitySnapshot => {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read snapshot '${path}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const snapshot = requireObject(value, 'snapshot')
  return snapshot as StorageStabilitySnapshot
}

const readSmartBaseline = (path: string): SmartBaseline => {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `Unable to read SMART baseline '${path}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const baseline = requireObject(value, 'SMART baseline') as SmartBaseline
  validateSmartBaselineShape(baseline, 'SMART baseline')
  return baseline
}

const printResult = (result: StorageStabilityGateResult, output: OutputFormat) => {
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
  if (options.captureSmartBaselinePath) {
    ensureCli('kubectl')
    const baseline = createSmartBaseline(await collectSmartDeviceEvidence(), new Date())
    writeSmartBaseline(options.captureSmartBaselinePath, baseline)
    if (options.output === 'json') {
      console.log(JSON.stringify({ path: options.captureSmartBaselinePath, baseline }, null, 2))
    } else {
      console.log(`SMART baseline written to ${options.captureSmartBaselinePath}`)
      console.log(`Observation start: ${baseline.capturedAt}`)
    }
    return
  }
  const snapshot = options.snapshotPath
    ? readSnapshot(options.snapshotPath)
    : await collectStorageStabilitySnapshot(
        options.observationStartedAt!,
        readSmartBaseline(options.smartBaselinePath!),
        options.talosNode,
      )
  const result = evaluateStorageStabilityGate(snapshot)
  printResult(result, options.output)
  if (!result.ok) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((error) => fatal('Torghut storage stability gate failed to collect or validate evidence', error))
}

export const __private = {
  collectWorkloadEvidenceFromValues,
  collectStorageStabilitySnapshotWith,
  collectJangarPostgresEvidence,
  collectPostgresEvidence,
  controllerEventDurationMs,
  createSmartBaseline,
  kafkaFailureClass,
  parseKubernetesLogLine,
  parseArgs,
  parseTalosLine,
  readSmartBaseline,
  smartBaselineCaptureFailures,
  talosFailureClass,
  writeSmartBaseline,
}
