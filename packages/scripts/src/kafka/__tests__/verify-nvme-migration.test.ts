import { describe, expect, it } from 'bun:test'

import {
  compareRecordWitnesses,
  compareFileWitnesses,
  compareSnapshots,
  fileWitnessCoverageFailures,
  parseMetaProperties,
  parseTopicDescribe,
  recordWitnessCoverageFailures,
  validateTopicInventory,
  type KafkaSnapshot,
  type RecordWitness,
  type FileWitness,
} from '../verify-nvme-migration'

const snapshot = (): KafkaSnapshot => ({
  schemaVersion: 1,
  capturedAt: '2026-11-08T00:00:00.000Z',
  context: 'galactic-tailscale',
  namespace: 'kafka',
  clusterName: 'kafka',
  pod: 'kafka-pool-b-3',
  bootstrap: 'kafka-kafka-bootstrap:9093',
  clusterId: 'cluster-a',
  identities: [
    { nodeId: 0, directoryId: 'controller-directory', logEndOffset: '42', lag: '0', status: 'Leader' },
    { nodeId: 3, directoryId: 'broker-directory', logEndOffset: '42', lag: '0', status: 'Observer' },
  ],
  metaProperties: [
    {
      pod: 'kafka-pool-a-0',
      mountPath: '/var/lib/kafka/data',
      clusterId: 'cluster-a',
      nodeId: 0,
      directoryId: 'controller-meta-directory',
    },
    {
      pod: 'kafka-pool-b-3',
      mountPath: '/var/lib/kafka/data',
      clusterId: 'cluster-a',
      nodeId: 3,
      directoryId: 'broker-directory',
    },
  ],
  topics: [
    {
      name: 'bayn.native-arrival.v1',
      topicId: 'topic-a',
      declaredPartitionCount: 1,
      configs: 'cleanup.policy=delete,retention.ms=604800000',
      partitions: [
        {
          partition: 0,
          leader: 3,
          replicas: [3, 4, 5],
          isr: [3, 4, 5],
          startOffset: '10',
          endOffset: '20',
          logDirs: [],
        },
      ],
    },
  ],
  listedTopics: ['bayn.native-arrival.v1'],
  groups: [
    {
      group: 'bayn-native-arrival',
      topic: 'bayn.native-arrival.v1',
      partition: 0,
      currentOffset: '17',
      logEndOffset: '20',
      lag: '3',
    },
  ],
  quorum: {
    leaderId: 0,
    highWatermark: '42',
    maxFollowerLag: '0',
    maxFollowerLagTimeMs: '0',
    voterIds: [0, 1, 2],
  },
  storage: {
    bindings: [
      {
        pod: 'kafka-pool-b-3',
        node: 'talos-192-168-1-194',
        nodeId: 3,
        directoryId: 'broker-directory',
        role: 'broker',
        pvc: 'data-0',
        pv: 'pv-0',
        phase: 'Bound',
        storageClass: 'kafka-nvme-local',
        provisioner: 'kubernetes.io/no-provisioner',
        capacity: '200Gi',
        source: 'local',
        path: '/var/mnt/local-path-provisioner/kafka/data-0',
        mountPath: '/var/lib/kafka/data-0',
        csiDriver: null,
        nodeAffinity: null,
      },
    ],
    nvmeEvidence: {
      schemaVersion: 1,
      nodes: [
        {
          node: 'talos-192-168-1-194',
          mounts: [{ mountpoint: '/var/mnt/local-path-provisioner', device: '/dev/nvme0n1p4' }],
        },
      ],
    },
  },
})

const witness = (sha256: string): RecordWitness => ({
  topic: 'bayn.native-arrival.v1',
  partition: 0,
  startOffset: '10',
  endOffset: '20',
  recordCount: 10,
  sha256,
})

describe('Kafka NVMe migration verifier', () => {
  it('passes an unchanged quiesced snapshot with verified local NVMe storage', () => {
    const baseline = snapshot()
    const report = compareSnapshots(baseline, structuredClone(baseline), {
      requiredGroups: ['bayn-native-arrival'],
      requiredNodes: ['talos-192-168-1-194'],
    })

    expect(report.pass).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.checks).toEqual({
      clusterId: true,
      topicInventory: true,
      partitionOffsets: true,
      replication: true,
      topicConfigs: true,
      groupOffsets: true,
      controllerQuorum: true,
      nvmeStorage: true,
      recordWitnesses: true,
      fileWitnesses: true,
    })
  })

  it('fails when the cluster identity, exact offsets, or committed group offset changes', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    current.clusterId = 'cluster-b'
    current.topics[0].partitions[0].endOffset = '21'
    current.groups[0].currentOffset = '18'

    const report = compareSnapshots(baseline, current, {
      requiredGroups: ['bayn-native-arrival'],
      exactGroups: ['bayn-native-arrival'],
      allowOffsetAdvance: false,
    })

    expect(report.pass).toBe(false)
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'Kafka cluster ID changed (cluster-a -> cluster-b)',
        'Kafka offsets changed for bayn.native-arrival.v1[0]',
        'Kafka committed offset changed for bayn-native-arrival/bayn.native-arrival.v1\u00000',
      ]),
    )
  })

  it('fails when a partition is not fully in ISR or a topic disappears', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    current.topics[0].partitions[0].isr = [3]
    current.topics[0].partitions[0].replicas = [3, 4]

    const report = compareSnapshots(baseline, current)

    expect(report.pass).toBe(false)
    expect(report.failures).toContain('Kafka replication/ISR is not fully healthy for bayn.native-arrival.v1[0]')
    expect(report.checks.replication).toBe(false)
  })

  it('requires exact record hashes and full range coverage for selected topics', () => {
    const baseline = snapshot()
    const before = [witness('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')]
    const after = [witness('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')]

    expect(compareRecordWitnesses(before, after)).toEqual(['record witness bayn.native-arrival.v1/p0 sha256 changed'])
    expect(recordWitnessCoverageFailures(baseline, before, ['bayn.native-arrival.v1'])).toEqual([])
    expect(recordWitnessCoverageFailures(baseline, [], ['bayn.native-arrival.v1'])).toEqual([
      'record witness is missing bayn.native-arrival.v1[0]',
    ])
    expect(compareRecordWitnesses([], [])).toEqual(['record witness set is empty; preserved records are unproven'])
    expect(recordWitnessCoverageFailures(baseline, before, [])).toEqual([
      'record witness topic scope is empty; pass --required-witness-topic explicitly',
    ])
    expect(
      recordWitnessCoverageFailures(
        baseline,
        [{ ...before[0], topic: 'unrelated.topic.v1' }],
        ['bayn.native-arrival.v1'],
      ),
    ).toContain('record witness topic is outside the required scope: unrelated.topic.v1')
  })

  it('rejects a Ceph binding even when the PVC is bound', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    current.storage.bindings[0].storageClass = 'rook-ceph-block'

    const report = compareSnapshots(baseline, current)

    expect(report.pass).toBe(false)
    expect(report.failures).toContain('Kafka PVC data-0 still uses Ceph storage (rook-ceph-block)')
  })

  it('requires exact file hashes for the copied Kafka data scope', () => {
    const file = (sha256: string): FileWitness => ({
      nodeId: 3,
      directoryId: 'broker-directory',
      mountPath: '/var/lib/kafka/data',
      relativePath: 'bayn.native-arrival.v1-0/00000000000000000010.log',
      sizeBytes: '1234',
      sha256,
    })

    expect(compareFileWitnesses([file('a'.repeat(64))], [file('a'.repeat(64))])).toEqual([])
    expect(compareFileWitnesses([file('a'.repeat(64))], [file('b'.repeat(64))])).toEqual([
      'file witness hash changed for 3/broker-directory//var/lib/kafka/data/bayn.native-arrival.v1-0/00000000000000000010.log',
    ])
    expect(compareFileWitnesses([], [])).toEqual(['file witness set is empty; copied data is unproven'])
    expect(fileWitnessCoverageFailures(snapshot(), [file('a'.repeat(64))], [file('a'.repeat(64))])).toEqual([
      'file witness is missing baseline mounted identity: 0/controller-meta-directory//var/lib/kafka/data',
      'file witness is missing current mounted identity: 0/controller-meta-directory//var/lib/kafka/data',
    ])
    const unrelated = { ...file('a'.repeat(64)), nodeId: 99, directoryId: 'unrelated-directory' }
    expect(fileWitnessCoverageFailures(snapshot(), [unrelated], [unrelated])).toEqual(
      expect.arrayContaining(['file witness identity is outside mounted Kafka scope: 99//var/lib/kafka/data']),
    )
  })

  it('rejects incomplete or malformed topic describe output and requires list parity', () => {
    const incomplete =
      'Topic: bayn.native-arrival.v1 TopicId: topic-a PartitionCount: 2 ReplicationFactor: 1 Configs:\n' +
      'Topic: bayn.native-arrival.v1 Partition: 0 Leader: 3 Replicas: 3 Isr: 3 Elr: '
    expect(() => parseTopicDescribe(incomplete)).toThrow('partition inventory is incomplete')
    expect(
      parseTopicDescribe(
        'Topic: unavailable.topic.v1 TopicId: topic-b PartitionCount: 1 ReplicationFactor: 1 Configs:\n' +
          'Topic: unavailable.topic.v1 Partition: 0 Leader: none Replicas: 3 Isr: Elr: 3',
      )[0].partitions[0].leader,
    ).toBe(-1)
    expect(() => parseTopicDescribe('Topic: bayn.native-arrival.v1 TopicId: topic-a PartitionCount: 1')).toThrow(
      'malformed row',
    )
    expect(() => validateTopicInventory(['other.topic.v1'], [snapshot().topics[0]])).toThrow(
      'topic inventories disagree',
    )
  })

  it('allows an exact group commit while its log end advances during writes', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    current.groups[0].logEndOffset = '21'
    const report = compareSnapshots(baseline, current, {
      requiredGroups: ['bayn-native-arrival'],
      exactGroups: ['bayn-native-arrival'],
      allowOffsetAdvance: true,
    })

    expect(report.pass).toBe(true)
  })

  it('gates directory identity on mounted meta.properties, not quorum sentinel IDs', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    current.identities[0].directoryId = 'different-quorum-sentinel'
    expect(compareSnapshots(baseline, current).pass).toBe(true)

    current.metaProperties[0].directoryId = 'different-mounted-directory'
    const report = compareSnapshots(baseline, current)
    expect(report.pass).toBe(false)
    expect(report.failures).toContain('Kafka meta.properties directory ID changed for node 0')
    expect(
      parseMetaProperties(
        'version=1\ncluster.id=cluster-a\nnode.id=3\ndirectory.id=broker-directory\n',
        'kafka-pool-b-3',
        '/var/lib/kafka/data',
      ),
    ).toEqual({
      pod: 'kafka-pool-b-3',
      mountPath: '/var/lib/kafka/data',
      clusterId: 'cluster-a',
      nodeId: 3,
      directoryId: 'broker-directory',
    })
  })

  it('does not drop baseline groups when required-group narrows the requested set', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    current.groups = []
    const report = compareSnapshots(baseline, current, { requiredGroups: ['unseen-group'] })

    expect(report.pass).toBe(false)
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'Kafka group offset partitions changed for bayn-native-arrival',
        'Required Kafka consumer group has no baseline offsets: unseen-group',
      ]),
    )
  })

  it('treats exact-group as an explicit group requirement even when absent from baseline', () => {
    const report = compareSnapshots(snapshot(), snapshot(), { exactGroups: ['mistyped-group'] })

    expect(report.pass).toBe(false)
    expect(report.failures).toContain('Required Kafka consumer group has no baseline offsets: mistyped-group')
  })

  it('rejects null committed offsets for explicitly required groups', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    baseline.groups[0].currentOffset = null
    current.groups[0].currentOffset = null

    const report = compareSnapshots(baseline, current, { requiredGroups: ['bayn-native-arrival'] })

    expect(report.pass).toBe(false)
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'Kafka explicit consumer group has null baseline committed offset: bayn-native-arrival',
        'Kafka explicit consumer group has null current committed offset: bayn-native-arrival',
      ]),
    )
  })

  it('fails closed for zero parsed partitions and selects the deepest NVMe mount', () => {
    const baseline = snapshot()
    const empty = structuredClone(baseline)
    empty.topics = []
    empty.listedTopics = []
    const emptyReport = compareSnapshots(empty, empty)
    expect(emptyReport.pass).toBe(false)
    expect(emptyReport.failures).toContain('Kafka snapshot contains zero parsed partitions; migration data is unproven')

    const nested = structuredClone(baseline)
    nested.storage.nvmeEvidence!.nodes[0].mounts = [
      { mountpoint: '/var/mnt', device: '/dev/sdb' },
      { mountpoint: '/var/mnt/local-path-provisioner', device: '/dev/nvme0n1p4' },
    ]
    expect(compareSnapshots(baseline, nested).pass).toBe(true)
  })
})
