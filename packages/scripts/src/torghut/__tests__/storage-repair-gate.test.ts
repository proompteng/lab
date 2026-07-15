import { describe, expect, it } from 'bun:test'

import { __private, evaluateStorageRepairGate, type StorageRepairSnapshot } from '../storage-repair-gate'

const capturedAt = '2026-07-16T12:00:00.000Z'
const repairStartedAt = '2026-07-15T11:00:00.000Z'

const healthySnapshot = (): StorageRepairSnapshot => ({
  schemaVersion: 'torghut.storage-repair-gate.v1',
  capturedAt,
  repairStartedAt,
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
      powerOnHours: 1_025,
      extendedPollingMinutes: 2_415,
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
      powerOnHours: 1_025,
      extendedPollingMinutes: 2_415,
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
      powerOnHours: 1_025,
      extendedPollingMinutes: 2_415,
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
    { name: 'torghut-options-archive', desiredReplicas: 0, readyReplicas: 0 },
    { name: 'torghut-hyperliquid-clickhouse-writer', desiredReplicas: 0, readyReplicas: 0 },
  ],
  argoApplications: [
    { name: 'kafka', sync: 'Synced', health: 'Healthy' },
    { name: 'rook-ceph', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut-hyperliquid-feed', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut-hyperliquid-runtime', sync: 'Synced', health: 'Healthy' },
    { name: 'torghut-options', sync: 'Synced', health: 'Healthy' },
  ],
})

describe('Torghut storage repair gate', () => {
  it('accepts a complete healthy observation while preserving timeout containment', () => {
    const result = evaluateStorageRepairGate(healthySnapshot())

    expect(result.ok).toBe(true)
    expect(result.observationHours).toBe(25)
    expect(result.failures).toEqual([])
    expect(result.warnings).toEqual([
      'Kafka controller timeout overrides remain active; this storage gate does not authorize their removal',
    ])
    expect(result.summaryLines.at(-1)).toBe('Activation verdict: PASS')
  })

  it('fails when the observation is shorter than 24 hours or dmesg coverage starts late', () => {
    const snapshot = healthySnapshot()
    snapshot.repairStartedAt = '2026-07-15T13:00:00Z'
    snapshot.talos.coverageStartedAt = '2026-07-15T14:00:00Z'

    const result = evaluateStorageRepairGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('at least 24 hours is required')
    expect(result.failures.join('\n')).toContain('after repair start')
  })

  it.each([
    ['sd 0:0:0:0: Power-on or device reset occurred', 'SAS transport reset'],
    ['mpt3sas_cm0: fault reset requested', 'SAS transport reset'],
    ['sd 0:0:0:0: [sda] Synchronize Cache(10) failed', 'durable cache-flush I/O failure'],
    ['I/O error, dev sda, sector 0 op WRITE', 'durable cache-flush I/O failure'],
  ])('fails on post-repair Talos evidence: %s', (message, expected) => {
    const snapshot = healthySnapshot()
    snapshot.talos.lines.push({ timestamp: '2026-07-16T11:00:00Z', message })

    const result = evaluateStorageRepairGate(snapshot)

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

    const result = evaluateStorageRepairGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('expected HEALTH_OK')
    expect(result.failures.join('\n')).toContain('BLUESTORE_SLOW_OP_ALERT')
    expect(result.failures.join('\n')).toContain('total=6 up=5 in=6')
    expect(result.failures.join('\n')).toContain('active+undersized+degraded')
    expect(result.failures.join('\n')).toContain('2026-07-14T20:18:05Z_osd3')
  })

  it('requires a healthy extended SMART test completed after repair on every SAS disk', () => {
    const snapshot = healthySnapshot()
    snapshot.smartDevices[0].latestExtendedSelfTest = {
      lifetimeHours: 819,
      passed: false,
      status: 'Interrupted (host reset)',
    }
    snapshot.smartDevices[0].criticalAttributes.currentPendingSectors = 1
    snapshot.smartDevices.pop()

    const result = evaluateStorageRepairGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('Interrupted (host reset)')
    expect(result.failures.join('\n')).toContain('predates the repair window')
    expect(result.failures.join('\n')).toContain('currentPendingSectors=1')
    expect(result.failures.join('\n')).toContain('SMART evidence is missing for /dev/sdc')
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

    const result = evaluateStorageRepairGate(snapshot)

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

    const result = evaluateStorageRepairGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('Kafka Ready condition is not True')
    expect(result.failures.join('\n')).toContain('does not match generation')
    expect(result.failures.join('\n')).toContain('started after the repair observation window began')
    expect(result.failures.join('\n')).toContain('is not ready')
    expect(result.failures.join('\n')).toContain('more than five minutes after repair start')
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

    const result = evaluateStorageRepairGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('expected [0, 1, 2]')
    expect(result.failures.join('\n')).toContain('max follower lag is 1001')
    expect(result.failures.join('\n')).toContain('max follower lag time is 5001 ms')
    expect(result.failures.join('\n')).toContain('under-replicated partitions')
    expect(result.failures.join('\n')).toContain('offline partitions')
  })

  it('fails when durability, WAL, containment, or Argo convergence regresses', () => {
    const snapshot = healthySnapshot()
    snapshot.postgres.settings.fsync = 'off'
    snapshot.postgres.walBytesPerSecond = 300_000
    snapshot.postgres.walSampleSeconds = 29
    snapshot.workloads[0].desiredReplicas = 1
    snapshot.argoApplications.find(({ name }) => name === 'rook-ceph')!.health = 'Degraded'

    const result = evaluateStorageRepairGate(snapshot)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('PostgreSQL fsync is off')
    expect(result.failures.join('\n')).toContain('limit is 0.25 MiB/s')
    expect(result.failures.join('\n')).toContain('at least 30 seconds is required')
    expect(result.failures.join('\n')).toContain('torghut-options-archive must remain contained')
    expect(result.failures.join('\n')).toContain('rook-ceph is sync=Synced health=Degraded')
  })

  it('fails closed when feed, scheduler, or current Knative revision readiness regresses', () => {
    const snapshot = healthySnapshot()
    snapshot.runtime.hyperliquidFeed.kafka = false
    snapshot.runtime.scheduler.tradingSuccessIsFresh = false
    snapshot.runtime.scheduler.leadership.acquired = false
    snapshot.runtime.knativeService.observedGeneration = 1_462
    snapshot.runtime.knativeService.latestCreatedRevision = 'torghut-01464'
    snapshot.runtime.knativeService.apiStatus = 'degraded'

    const result = evaluateStorageRepairGate(snapshot)

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

    expect(() => evaluateStorageRepairGate(snapshot)).toThrow(
      'snapshot.runtime.hyperliquidFeed.kafka must be a boolean',
    )
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
