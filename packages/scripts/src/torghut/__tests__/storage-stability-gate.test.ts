import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __private, evaluateStorageStabilityGate, type StorageStabilitySnapshot } from '../storage-stability-gate'

const capturedAt = '2026-07-17T12:00:00.000Z'
const observationStartedAt = '2026-07-15T11:00:00.000Z'

const healthySnapshot = (): StorageStabilitySnapshot => ({
  schemaVersion: 'torghut.storage-stability-gate.v4',
  capturedAt,
  observationStartedAt,
  smartBaseline: {
    schemaVersion: 'torghut.smart-baseline.v1',
    capturedAt: observationStartedAt,
    devices: [
      {
        device: '/dev/sda',
        serial: 'ZXA12R7C',
        smartPassed: true,
        criticalAttributes: {
          reallocatedSectors: 0,
          currentPendingSectors: 0,
          offlineUncorrectable: 0,
          udmaCrcErrors: 0,
        },
      },
      {
        device: '/dev/sdb',
        serial: 'ZXA0LKW9',
        smartPassed: true,
        criticalAttributes: {
          reallocatedSectors: 0,
          currentPendingSectors: 0,
          offlineUncorrectable: 0,
          udmaCrcErrors: 0,
        },
      },
      {
        device: '/dev/sdc',
        serial: 'ZXA0HS7E',
        smartPassed: true,
        criticalAttributes: {
          reallocatedSectors: 0,
          currentPendingSectors: 0,
          offlineUncorrectable: 0,
          udmaCrcErrors: 0,
        },
      },
    ],
  },
  talos: {
    node: '100.100.244.142',
    coverageStartedAt: '2026-07-15T10:00:00.000Z',
    lines: [
      {
        timestamp: '2026-07-16T10:00:00.000Z',
        message: 'sd 0:0:0:0: [sda] Attached SCSI disk',
      },
    ],
  },
  ceph: {
    health: 'HEALTH_OK',
    healthChecks: [],
    osds: { total: 6, up: 6, in: 6 },
    placementGroups: [
      { count: 599, state: 'active+clean' },
      { count: 1, state: 'active+clean+scrubbing' },
      { count: 1, state: 'active+clean+scrubbing+deep' },
    ],
    unacknowledgedCrashIds: [],
  },
  smartDevices: [
    {
      device: '/dev/sda',
      serial: 'ZXA12R7C',
      smartPassed: true,
      latestExtendedSelfTest: {
        lifetimeHours: 1_024,
        passed: true,
        status: 'Completed without error',
      },
      criticalAttributes: {
        reallocatedSectors: 0,
        currentPendingSectors: 0,
        offlineUncorrectable: 0,
        udmaCrcErrors: 0,
      },
    },
    {
      device: '/dev/sdb',
      serial: 'ZXA0LKW9',
      smartPassed: true,
      latestExtendedSelfTest: {
        lifetimeHours: 1_024,
        passed: true,
        status: 'Completed without error',
      },
      criticalAttributes: {
        reallocatedSectors: 0,
        currentPendingSectors: 0,
        offlineUncorrectable: 0,
        udmaCrcErrors: 0,
      },
    },
    {
      device: '/dev/sdc',
      serial: 'ZXA0HS7E',
      smartPassed: true,
      latestExtendedSelfTest: {
        lifetimeHours: 1_024,
        passed: true,
        status: 'Completed without error',
      },
      criticalAttributes: {
        reallocatedSectors: 0,
        currentPendingSectors: 0,
        offlineUncorrectable: 0,
        udmaCrcErrors: 0,
      },
    },
  ],
  kafka: {
    ready: true,
    generation: 28,
    observedGeneration: 28,
    kafkaVersion: '4.3.0',
    metadataVersion: '4.3-IV0',
    operatorVersion: '1.1.0',
    pods: [
      { name: 'kafka-pool-a-0', ready: true, role: 'controller', startedAt: '2026-07-14T01:00:00Z' },
      { name: 'kafka-pool-a-1', ready: true, role: 'controller', startedAt: '2026-07-14T01:00:00Z' },
      { name: 'kafka-pool-a-2', ready: true, role: 'controller', startedAt: '2026-07-14T01:00:00Z' },
      { name: 'kafka-pool-b-3', ready: true, role: 'broker', startedAt: '2026-07-14T01:00:00Z' },
      { name: 'kafka-pool-b-4', ready: true, role: 'broker', startedAt: '2026-07-14T01:00:00Z' },
      { name: 'kafka-pool-b-5', ready: true, role: 'broker', startedAt: '2026-07-14T01:00:00Z' },
    ],
    unreadyTopics: [],
    underReplicatedPartitions: [],
    offlinePartitions: [],
    quorum: {
      leaderId: 2,
      voterIds: [0, 1, 2],
      maxFollowerLag: 3,
      maxFollowerLagTimeMs: 1_846,
    },
    controllerLogs: [
      {
        pod: 'kafka-pool-a-0',
        coverageStartedAt: '2026-07-15T11:00:01Z',
        lines: [{ timestamp: '2026-07-16T10:00:00Z', message: '[RaftManager id=0] High watermark advanced' }],
      },
      {
        pod: 'kafka-pool-a-1',
        coverageStartedAt: '2026-07-15T11:00:02Z',
        lines: [{ timestamp: '2026-07-16T10:00:00Z', message: '[RaftManager id=1] High watermark advanced' }],
      },
      {
        pod: 'kafka-pool-a-2',
        coverageStartedAt: '2026-07-15T11:00:03Z',
        lines: [
          {
            timestamp: '2026-07-16T10:00:00Z',
            message: 'Exceptionally slow controller event maybeFenceStaleBroker(1) took 1500 ms.',
          },
        ],
      },
    ],
    controllerTimeoutOverrides: {
      electionMs: 60_000,
      fetchMs: 180_000,
    },
  },
  postgres: {
    ready: true,
    settings: {
      fsync: 'on',
      fullPageWrites: 'on',
      synchronousCommit: 'on',
      walBuffers: '16MB',
    },
    walBytesPerSecond: 10_000,
    walSampleSeconds: 30.1,
  },
  jangarPostgres: {
    ready: true,
    settings: {
      fsync: 'on',
      fullPageWrites: 'on',
      synchronousCommit: 'on',
      walBuffers: '4MB',
    },
    walBytesPerSecond: 100_000,
    walSampleSeconds: 30.1,
  },
  runtime: {
    hyperliquidFeed: {
      httpOk: true,
      status: 'ready',
      ready: true,
      websocket: true,
      kafka: true,
      clickhouse: true,
    },
    scheduler: {
      httpOk: true,
      ok: true,
      processRole: 'scheduler',
      running: true,
      tradingSuccessIsFresh: true,
      reconcileSuccessIsFresh: true,
      leadership: {
        required: true,
        acquired: true,
        healthy: true,
      },
    },
    knativeService: {
      generation: 1_463,
      observedGeneration: 1_463,
      ready: true,
      latestCreatedRevision: 'torghut-01463',
      latestReadyRevision: 'torghut-01463',
      apiHttpOk: true,
      apiStatus: 'ok',
      apiProcessRole: 'api',
      runtimeOwner: 'torghut-scheduler',
    },
  },
  workloads: [
    {
      name: 'torghut-options-archive',
      desiredReplicas: 0,
      actualReplicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
      terminatingReplicas: 0,
      podNames: [],
    },
  ],
  argoApplications: [
    { name: 'jangar', sync: 'Synced', health: 'Healthy' },
    { name: 'kafka', sync: 'Synced', health: 'Healthy' },
    { name: 'rook-ceph', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut-hyperliquid-feed', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut-hyperliquid-runtime', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut-options', sync: 'Synced', health: 'Healthy' },
  ],
})

describe('Torghut storage stability gate', () => {
  it('accepts a complete healthy observation while preserving timeout containment', () => {
    const result = evaluateStorageStabilityGate(healthySnapshot())

    expect(result.ok).toBe(true)
    expect(result.observationMinutes).toBe(2_940)
    expect(result.failures).toEqual([])
    expect(result.warnings).toEqual([
      'Kafka controller timeout overrides remain active; this storage gate does not authorize their removal',
    ])
    expect(result.summaryLines.at(-1)).toBe('Activation verdict: PASS')
  })

  it('fails when the observation is shorter than 30 minutes or dmesg coverage starts late', () => {
    const snapshot = healthySnapshot()
    snapshot.observationStartedAt = '2026-07-17T11:45:00Z'
    snapshot.talos.coverageStartedAt = '2026-07-17T11:46:00Z'

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('at least 30 minutes is required')
    expect(result.failures.join('\n')).toContain('after observation start')
  })

  it.each([
    ['sd 0:0:0:0: Power-on or device reset occurred', 'SCSI device reset/recovery'],
    ['mpt3sas_cm0: fault reset requested', 'SCSI device reset/recovery'],
    ['sd 0:0:0:0: [sda] Synchronize Cache(10) failed', 'durable cache-flush I/O failure'],
    ['I/O error, dev sda, sector 0 op WRITE', 'durable cache-flush I/O failure'],
  ])('fails on SCSI or durable-write errors inside the observation window: %s', (message, expected) => {
    const snapshot = healthySnapshot()
    snapshot.talos.lines.push({ timestamp: '2026-07-16T11:00:00Z', message })

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain(expected)
  })

  it('fails closed for Ceph warnings, crashes, missing OSDs, and unsafe placement groups', () => {
    const snapshot = healthySnapshot()
    snapshot.ceph.health = 'HEALTH_WARN'
    snapshot.ceph.healthChecks = ['BLUESTORE_SLOW_OP_ALERT', 'RECENT_CRASH']
    snapshot.ceph.osds.up = 5
    snapshot.ceph.placementGroups.push({ count: 2, state: 'active+undersized+degraded' })
    snapshot.ceph.unacknowledgedCrashIds = ['2026-07-14T20:18:05Z_osd3']

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('expected HEALTH_OK')
    expect(result.failures.join('\n')).toContain('BLUESTORE_SLOW_OP_ALERT')
    expect(result.failures.join('\n')).toContain('total=6 up=5 in=6')
    expect(result.failures.join('\n')).toContain('active+undersized+degraded')
    expect(result.failures.join('\n')).toContain('2026-07-14T20:18:05Z_osd3')
  })

  it('requires current SMART health, zero media counters, and every expected disk', () => {
    const snapshot = healthySnapshot()
    snapshot.smartDevices[0].latestExtendedSelfTest = {
      lifetimeHours: 819,
      passed: false,
      status: 'Interrupted (host reset)',
    }
    snapshot.smartDevices[0].criticalAttributes.currentPendingSectors = 1
    snapshot.smartDevices.pop()

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).not.toContain('Interrupted (host reset)')
    expect(result.failures.join('\n')).toContain('currentPendingSectors=1')
    expect(result.failures.join('\n')).toContain('SMART evidence is missing for /dev/sdc')
    expect(result.warnings.join('\n')).toContain("is 'Interrupted (host reset)'")
  })

  it('accepts a historical UDMA CRC count only when it is unchanged from the observation baseline', () => {
    const snapshot = healthySnapshot()
    snapshot.smartBaseline.devices[2].criticalAttributes.udmaCrcErrors = 1
    snapshot.smartDevices[2].criticalAttributes.udmaCrcErrors = 1

    expect(evaluateStorageStabilityGate(snapshot).ok).toBe(true)

    snapshot.smartDevices[2].criticalAttributes.udmaCrcErrors = 2
    const increased = evaluateStorageStabilityGate(snapshot)
    expect(increased.ok).toBe(false)
    expect(increased.failures.join('\n')).toContain(
      'SMART lifetime UDMA CRC error counter changed for /dev/sdc from 1 at observation start to 2',
    )

    snapshot.smartDevices[2].criticalAttributes.udmaCrcErrors = 0
    const reset = evaluateStorageStabilityGate(snapshot)
    expect(reset.ok).toBe(false)
    expect(reset.failures.join('\n')).toContain(
      'SMART lifetime UDMA CRC error counter changed for /dev/sdc from 1 at observation start to 0',
    )
  })

  it('fails when the SMART baseline does not exactly anchor the observation start or is unhealthy', () => {
    const snapshot = healthySnapshot()
    snapshot.smartBaseline.capturedAt = '2026-07-15T10:59:59.000Z'
    snapshot.smartBaseline.devices[0].smartPassed = false
    snapshot.smartBaseline.devices[1].criticalAttributes.reallocatedSectors = 1
    snapshot.smartBaseline.devices.pop()

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('must exactly match observation start')
    expect(result.failures.join('\n')).toContain('overall health failed at observation start for /dev/sda')
    expect(result.failures.join('\n')).toContain('reallocatedSectors=1')
    expect(result.failures.join('\n')).toContain('SMART baseline is missing for /dev/sdc')
  })

  it('creates a no-delta baseline with non-zero lifetime CRC history but rejects unsafe media state', () => {
    const snapshot = healthySnapshot()
    snapshot.smartDevices[2].criticalAttributes.udmaCrcErrors = 1
    const baseline = __private.createSmartBaseline(snapshot.smartDevices, new Date(observationStartedAt))

    expect(baseline.capturedAt).toBe(observationStartedAt)
    expect(baseline.devices[2].criticalAttributes.udmaCrcErrors).toBe(1)
    expect(__private.smartBaselineCaptureFailures(baseline)).toEqual([])

    baseline.devices[0].criticalAttributes.currentPendingSectors = 1
    expect(__private.smartBaselineCaptureFailures(baseline).join('\n')).toContain('currentPendingSectors=1')
  })

  it('writes a baseline once and never overwrites an existing observation anchor', () => {
    const directory = mkdtempSync(join(tmpdir(), 'torghut-smart-baseline-'))
    const path = join(directory, 'baseline.json')
    const baseline = __private.createSmartBaseline(healthySnapshot().smartDevices, new Date(observationStartedAt))

    try {
      __private.writeSmartBaseline(path, baseline)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(baseline)

      writeFileSync(path, 'preserve-me')
      expect(() => __private.writeSmartBaseline(path, baseline)).toThrow('Unable to write SMART baseline')
      expect(readFileSync(path, 'utf8')).toBe('preserve-me')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('requires one explicit CLI mode and a baseline for every live observation', () => {
    expect(__private.parseArgs(['--capture-smart-baseline', '/tmp/baseline.json'])).toMatchObject({
      captureSmartBaselinePath: '/tmp/baseline.json',
    })
    expect(
      __private.parseArgs(['--observation-start', observationStartedAt, '--smart-baseline', '/tmp/baseline.json']),
    ).toMatchObject({ observationStartedAt, smartBaselinePath: '/tmp/baseline.json' })
    expect(() => __private.parseArgs(['--observation-start', observationStartedAt])).toThrow(
      'live collection requires --smart-baseline',
    )
    expect(() =>
      __private.parseArgs(['--capture-smart-baseline', '/tmp/baseline.json', '--snapshot', '/tmp/snapshot.json']),
    ).toThrow('select exactly one mode')
  })

  it('does not require a new extended SMART test when current device evidence is healthy', () => {
    const snapshot = healthySnapshot()
    snapshot.smartDevices[0].latestExtendedSelfTest = null
    for (const smart of snapshot.smartDevices.slice(1)) {
      smart.latestExtendedSelfTest = {
        lifetimeHours: 819,
        passed: false,
        status: 'Interrupted (host reset)',
      }
    }

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.warnings.filter((warning) => warning.includes('historical test'))).toHaveLength(2)
  })

  it('fails on KRaft timeouts and controller durable events above two seconds', () => {
    const snapshot = healthySnapshot()
    snapshot.kafka.controllerLogs[0].lines.push({
      timestamp: '2026-07-16T11:00:00Z',
      message: '[RaftManager id=0] Disconnecting from node 2 due to request timeout.',
    })
    snapshot.kafka.controllerLogs[2].lines.push({
      timestamp: '2026-07-16T11:00:01Z',
      message: 'EventPerformanceMonitor - Exceptionally slow controller event writeNoOpRecord(1) took 2001 ms.',
    })

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('KRaft fetch/request timeout')
    expect(result.failures.join('\n')).toContain('exceeded 2000 ms')
  })

  it('fails on incomplete Kafka coverage, readiness, or generation convergence', () => {
    const snapshot = healthySnapshot()
    snapshot.kafka.ready = false
    snapshot.kafka.observedGeneration = 27
    snapshot.kafka.pods[0].startedAt = '2026-07-15T12:00:00Z'
    snapshot.kafka.pods[1].ready = false
    snapshot.kafka.controllerLogs[0].coverageStartedAt = '2026-07-15T11:06:00Z'
    snapshot.kafka.controllerLogs = snapshot.kafka.controllerLogs.filter(({ pod }) => pod !== 'kafka-pool-a-2')
    snapshot.kafka.unreadyTopics = ['torghut.options.v1']

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('Kafka Ready condition is not True')
    expect(result.failures.join('\n')).toContain('does not match generation')
    expect(result.failures.join('\n')).toContain('started after the storage stability observation window began')
    expect(result.failures.join('\n')).toContain('is not ready')
    expect(result.failures.join('\n')).toContain('more than five minutes after observation start')
    expect(result.failures.join('\n')).toContain('logs are missing for kafka-pool-a-2')
    expect(result.failures.join('\n')).toContain('torghut.options.v1')
  })

  it('fails on quorum drift, follower lag, under-replication, and offline partitions', () => {
    const snapshot = healthySnapshot()
    snapshot.kafka.quorum.leaderId = 3
    snapshot.kafka.quorum.voterIds = [0, 1, 3]
    snapshot.kafka.quorum.maxFollowerLag = 1_001
    snapshot.kafka.quorum.maxFollowerLagTimeMs = 5_001
    snapshot.kafka.underReplicatedPartitions = ['Topic: a Partition: 0']
    snapshot.kafka.offlinePartitions = ['Topic: b Partition: 1']

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('expected [0, 1, 2]')
    expect(result.failures.join('\n')).toContain('max follower lag is 1001')
    expect(result.failures.join('\n')).toContain('max follower lag time is 5001 ms')
    expect(result.failures.join('\n')).toContain('under-replicated partitions')
    expect(result.failures.join('\n')).toContain('offline partitions')
  })

  it('fails when positive KRaft follower lag has an unknown age', () => {
    const snapshot = healthySnapshot()
    snapshot.kafka.quorum.maxFollowerLag = 1
    snapshot.kafka.quorum.maxFollowerLagTimeMs = -1

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('max follower lag time is unknown (-1 ms) while follower lag is 1')
  })

  it('fails when durability, WAL, containment, or Argo convergence regresses', () => {
    const snapshot = healthySnapshot()
    snapshot.postgres.settings.fsync = 'off'
    snapshot.postgres.walBytesPerSecond = 300_000
    snapshot.postgres.walSampleSeconds = 29
    snapshot.jangarPostgres.settings.synchronousCommit = 'off'
    snapshot.jangarPostgres.walBytesPerSecond = 400_000
    snapshot.jangarPostgres.walSampleSeconds = 29
    snapshot.workloads[0].desiredReplicas = 1
    snapshot.argoApplications.find(({ name }) => name === 'rook-ceph')!.health = 'Degraded'

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('PostgreSQL fsync is off')
    expect(result.failures.join('\n')).toContain('limit is 0.25 MiB/s')
    expect(result.failures.join('\n')).toContain('Jangar PostgreSQL synchronous_commit is off')
    expect(result.failures.join('\n')).toContain('limit is 0.3015 MiB/s (50% of the 0.603 MiB/s pre-change baseline)')
    expect(result.failures.join('\n')).toContain('at least 30 seconds is required')
    expect(result.failures.join('\n')).toContain('torghut-options-archive must remain contained')
    expect(result.failures.join('\n')).toContain('rook-ceph is sync=Synced health=Degraded')
  })

  it('fails containment while any unready or terminating workload pod still exists', () => {
    const snapshot = healthySnapshot()
    snapshot.workloads[0].actualReplicas = 1
    snapshot.workloads[0].terminatingReplicas = 1
    snapshot.workloads[0].podNames = ['torghut-options-archive-7d9f8f6f65-abcde']

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('observed desired=0 actual=1 ready=0 available=0 terminating=1')
    expect(result.failures.join('\n')).toContain('pods=[torghut-options-archive-7d9f8f6f65-abcde]')
  })

  it('fails while the removed shadow writer deployment or any of its pods still exists', () => {
    const snapshot = healthySnapshot()
    snapshot.workloads.push({
      name: 'torghut-hyperliquid-clickhouse-writer',
      desiredReplicas: 0,
      actualReplicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
      terminatingReplicas: 1,
      podNames: ['torghut-hyperliquid-clickhouse-writer-75dd7d9ddc-abcde'],
    })

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain(
      'torghut-hyperliquid-clickhouse-writer must be absent after shadow-sink removal',
    )
    expect(result.failures.join('\n')).toContain('actual=1 ready=0 available=0 terminating=1')
    expect(result.failures.join('\n')).toContain('pods=[torghut-hyperliquid-clickhouse-writer-75dd7d9ddc-abcde]')
  })

  it('collects the contained workload from list-shaped deployment output', () => {
    const workloads = __private.collectWorkloadEvidenceFromValues(
      {
        items: [
          {
            metadata: { name: 'torghut-options-archive' },
            spec: { replicas: 0, selector: { matchLabels: { app: 'torghut-options-archive' } } },
            status: {},
          },
          {
            metadata: { name: 'torghut-scheduler' },
          },
        ],
      },
      {
        items: [
          {
            metadata: {
              name: 'torghut-options-archive-7d9f8f6f65-abcde',
              labels: { app: 'torghut-options-archive' },
              deletionTimestamp: '2026-07-15T17:00:00Z',
            },
          },
        ],
      },
    )

    expect(workloads).toEqual([
      {
        name: 'torghut-options-archive',
        desiredReplicas: 0,
        actualReplicas: 0,
        readyReplicas: 0,
        availableReplicas: 0,
        terminatingReplicas: 1,
        podNames: ['torghut-options-archive-7d9f8f6f65-abcde'],
      },
    ])
  })

  it('collects an orphaned removed-writer pod after its deployment disappears', () => {
    const workloads = __private.collectWorkloadEvidenceFromValues(
      {
        items: [
          {
            metadata: { name: 'torghut-options-archive' },
            spec: { replicas: 0, selector: { matchLabels: { app: 'torghut-options-archive' } } },
            status: {},
          },
        ],
      },
      {
        items: [
          {
            metadata: {
              name: 'torghut-hyperliquid-clickhouse-writer-75dd7d9ddc-abcde',
              labels: { app: 'torghut-hyperliquid-clickhouse-writer' },
              deletionTimestamp: '2026-07-15T17:10:00Z',
            },
          },
        ],
      },
    )

    expect(workloads).toEqual([
      {
        name: 'torghut-options-archive',
        desiredReplicas: 0,
        actualReplicas: 0,
        readyReplicas: 0,
        availableReplicas: 0,
        terminatingReplicas: 0,
        podNames: [],
      },
      {
        name: 'torghut-hyperliquid-clickhouse-writer',
        desiredReplicas: 0,
        actualReplicas: 1,
        readyReplicas: 0,
        availableReplicas: 0,
        terminatingReplicas: 1,
        podNames: ['torghut-hyperliquid-clickhouse-writer-75dd7d9ddc-abcde'],
      },
    ])
  })

  it('records the evidence cutoff after bounded samples and before Talos and Kafka tail collection', async () => {
    const source = healthySnapshot()
    const events: string[] = []
    const collected = await __private.collectStorageStabilitySnapshotWith(
      observationStartedAt,
      source.talos.node,
      source.smartBaseline,
      {
        now: () => {
          events.push('cutoff')
          return new Date(capturedAt)
        },
        ceph: async () => {
          events.push('ceph')
          return source.ceph
        },
        smartDevices: async () => {
          events.push('smart')
          return source.smartDevices
        },
        postgres: async () => {
          await Promise.resolve()
          events.push('postgres-complete')
          return source.postgres
        },
        jangarPostgres: async () => {
          await Promise.resolve()
          events.push('jangar-postgres-complete')
          return source.jangarPostgres
        },
        runtime: async () => {
          events.push('runtime')
          return source.runtime
        },
        workloads: async () => {
          events.push('workloads')
          return source.workloads
        },
        argoApplications: async () => {
          events.push('argo')
          return source.argoApplications
        },
        talos: async () => {
          events.push('talos-tail')
          return source.talos
        },
        kafka: async () => {
          events.push('kafka-tail')
          return source.kafka
        },
      },
    )

    expect(collected.capturedAt).toBe(capturedAt)
    expect(collected.smartBaseline).toEqual(source.smartBaseline)
    expect(events.indexOf('cutoff')).toBeGreaterThan(events.indexOf('postgres-complete'))
    expect(events.indexOf('cutoff')).toBeGreaterThan(events.indexOf('jangar-postgres-complete'))
    expect(events.indexOf('ceph')).toBeGreaterThan(events.indexOf('cutoff'))
    expect(events.indexOf('workloads')).toBeGreaterThan(events.indexOf('cutoff'))
    expect(events.indexOf('talos-tail')).toBeGreaterThan(events.indexOf('cutoff'))
    expect(events.indexOf('kafka-tail')).toBeGreaterThan(events.indexOf('cutoff'))
  })

  it('rechecks PostgreSQL readiness, primary, and durability after the WAL sample', async () => {
    const events: string[] = []
    let clusterRead = 0
    let nowRead = 0
    const evidence = await __private.collectPostgresEvidence({
      cluster: async () => {
        clusterRead += 1
        events.push(`cluster-${clusterRead}`)
        return {
          status: {
            currentPrimary: clusterRead === 1 ? 'torghut-db-1' : 'torghut-db-2',
            conditions: [{ type: 'Ready', status: clusterRead === 1 ? 'True' : 'False' }],
          },
        }
      },
      psql: async (primary, sql) => {
        if (sql.includes("current_setting('fsync')")) {
          events.push(`settings-${primary}`)
          return 'off|on|on|16MB'
        }
        events.push(`wal-${primary}`)
        return primary === 'torghut-db-1' ? '1000' : '2000'
      },
      sleep: async (milliseconds) => {
        events.push(`sleep-${milliseconds}`)
      },
      now: () => {
        nowRead += 1
        return nowRead === 1 ? 0 : 30_100
      },
    })

    expect(evidence.ready).toBe(false)
    expect(evidence.settings.fsync).toBe('off')
    expect(evidence.walSampleSeconds).toBe(30.1)
    expect(events).toEqual([
      'cluster-1',
      'wal-torghut-db-1',
      'sleep-30000',
      'cluster-2',
      'wal-torghut-db-2',
      'settings-torghut-db-2',
    ])
  })

  it('collects Jangar WAL from its current primary and labels collector failures', async () => {
    let clusterRead = 0
    let nowRead = 0
    const evidence = await __private.collectJangarPostgresEvidence({
      cluster: async () => {
        clusterRead += 1
        return {
          status: {
            currentPrimary: clusterRead === 1 ? 'jangar-db-1' : 'jangar-db-2',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        }
      },
      psql: async (primary, sql) => {
        if (sql.includes("current_setting('fsync')")) return 'on|on|on|4MB'
        return primary === 'jangar-db-1' ? '1000' : '4096'
      },
      sleep: async () => {},
      now: () => {
        nowRead += 1
        return nowRead === 1 ? 0 : 30_000
      },
    })

    expect(evidence).toEqual({
      ready: true,
      settings: {
        fsync: 'on',
        fullPageWrites: 'on',
        synchronousCommit: 'on',
        walBuffers: '4MB',
      },
      walBytesPerSecond: 103.2,
      walSampleSeconds: 30,
    })

    await expect(
      __private.collectJangarPostgresEvidence({
        cluster: async () => ({
          status: {
            currentPrimary: 'jangar-db-1',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        }),
        psql: async (_primary, sql) => (sql.includes("current_setting('fsync')") ? 'on|on|on' : '1000'),
        sleep: async () => {},
        now: () => 30_000,
      }),
    ).rejects.toThrow('Jangar PostgreSQL settings query returned 3 fields, expected 4')
  })

  it('fails closed when feed, scheduler, or current Knative revision readiness regresses', () => {
    const snapshot = healthySnapshot()
    snapshot.runtime.hyperliquidFeed.kafka = false
    snapshot.runtime.scheduler.tradingSuccessIsFresh = false
    snapshot.runtime.scheduler.leadership.acquired = false
    snapshot.runtime.knativeService.observedGeneration = 1_462
    snapshot.runtime.knativeService.latestCreatedRevision = 'torghut-01464'
    snapshot.runtime.knativeService.apiStatus = 'degraded'

    const result = evaluateStorageStabilityGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('Hyperliquid feed readiness failed')
    expect(result.failures.join('\n')).toContain('kafka=false')
    expect(result.failures.join('\n')).toContain('Torghut scheduler readiness failed')
    expect(result.failures.join('\n')).toContain('tradingFresh=false')
    expect(result.failures.join('\n')).toContain('does not match generation')
    expect(result.failures.join('\n')).toContain('latest created revision torghut-01464 is not ready')
    expect(result.failures.join('\n')).toContain('Torghut API readiness failed')
  })

  it('rejects malformed offline runtime evidence instead of relying on JavaScript truthiness', () => {
    const snapshot = healthySnapshot()
    snapshot.runtime.hyperliquidFeed.kafka = 'false' as unknown as boolean

    expect(() => evaluateStorageStabilityGate(snapshot)).toThrow(
      'snapshot.runtime.hyperliquidFeed.kafka must be a boolean',
    )
  })

  it.each([
    '[QuorumController id=2] Fencing broker 3 at epoch 42 because its session timed out',
    'Broker 3 was fenced because its session timed out',
    'Fenced broker 3 after registration expired',
  ])('classifies actual broker fencing: %s', (message) => {
    expect(__private.kafkaFailureClass(message)).toBe('broker fencing')
  })

  it.each([
    'Unfenced broker 3 after registration completed',
    'Broker 3 is unfenced and active',
    'Unfencing broker 3 after recovery',
    'Broker 3 registration remains unfenced',
  ])('does not classify broker recovery as fencing: %s', (message) => {
    expect(__private.kafkaFailureClass(message)).toBeUndefined()
  })

  it('parses timestamped Talos and Kubernetes log records', () => {
    expect(
      __private.parseTalosLine(
        '100.100.244.142: kern: info: [2026-07-15T00:17:42.955977958Z]: sda: Attached SCSI disk',
      ),
    ).toEqual({
      timestamp: '2026-07-15T00:17:42.955977958Z',
      message: 'sda: Attached SCSI disk',
    })
    expect(
      __private.parseKubernetesLogLine(
        '2026-07-15T00:20:05.037896560Z 2026-07-15 00:20:05 INFO EventPerformanceMonitor',
      ),
    ).toEqual({
      timestamp: '2026-07-15T00:20:05.037896560Z',
      message: '2026-07-15 00:20:05 INFO EventPerformanceMonitor',
    })
  })
})
