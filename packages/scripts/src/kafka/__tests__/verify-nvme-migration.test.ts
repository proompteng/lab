import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compareRecordWitnesses,
  compareFileWitnesses,
  compareSnapshots,
  fileWitnessCoverageFailures,
  parseCopyReceipt,
  parseMetaProperties,
  parseTopicDescribe,
  readCopyReceipts,
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
          logDirs: [3, 4, 5].map((broker) => ({
            broker,
            logDir: '/var/lib/kafka/data',
            sizeBytes: '1234',
            offsetLag: '0',
          })),
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

const copyReceipt = (baseline: KafkaSnapshot, nodeId = 3) => {
  const identity = baseline.metaProperties.find((candidate) => candidate.nodeId === nodeId)
  if (!identity) throw new Error(`missing fixture identity ${nodeId}`)
  const digest = 'd'.repeat(64)
  const manifest = JSON.stringify([
    { relativePath: 'kafka-log3/00000000000000000010.log', sizeBytes: '1234', sha256: 'a'.repeat(64) },
  ])
  const meta = JSON.stringify({
    'kafka-log3/meta.properties': {
      'cluster.id': baseline.clusterId,
      'node.id': String(identity.nodeId),
      'directory.id': identity.directoryId,
    },
  })
  const logs = [
    `SOURCE_MANIFEST_SHA256=${digest}`,
    `TARGET_MANIFEST_SHA256=${digest}`,
    'MANIFEST_ENTRIES=1',
    'SOURCE_TOTAL_BYTES=1234',
    'TARGET_TOTAL_BYTES=1234',
    `SOURCE_META_PROPERTIES=${meta}`,
    `TARGET_META_PROPERTIES=${meta}`,
    `SOURCE_FILE_MANIFEST=${manifest}`,
    `TARGET_FILE_MANIFEST=${manifest}`,
    'MANIFEST_DIFFERENCES=[]',
    'COPY_VERIFIED',
  ].join('\n')
  return {
    version: 1,
    phase: 'started',
    plan: { expectedClusterId: baseline.clusterId, nodeId },
    copyPod: { logs },
  }
}

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

  it('requires complete replica reports and zero replica lag for quiesced verification', () => {
    const baseline = snapshot()
    const current = structuredClone(baseline)
    current.topics[0].partitions[0].logDirs[1].offsetLag = '1'
    expect(compareSnapshots(baseline, current, { allowOffsetAdvance: false }).checks.replication).toBe(false)
    expect(compareSnapshots(baseline, current, { allowOffsetAdvance: true }).checks.replication).toBe(true)
    current.topics[0].partitions[0].logDirs[1].offsetLag = '-1'
    expect(compareSnapshots(baseline, current).checks.replication).toBe(false)
    current.topics[0].partitions[0].logDirs.pop()
    expect(compareSnapshots(baseline, current).failures).toContain(
      'Kafka replica log-directory coverage is incomplete for bayn.native-arrival.v1[0]',
    )
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

  it('derives file witnesses from verified copy receipts and rejects altered receipt evidence', () => {
    const baseline = snapshot()
    const receipt = copyReceipt(baseline)
    const proof = parseCopyReceipt(receipt, baseline)

    expect(proof.failures).toEqual([])
    expect(proof.sourceFiles).toEqual([
      {
        nodeId: 3,
        directoryId: 'broker-directory',
        mountPath: '/var/lib/kafka/data',
        relativePath: 'kafka-log3/00000000000000000010.log',
        sizeBytes: '1234',
        sha256: 'a'.repeat(64),
      },
    ])
    expect(fileWitnessCoverageFailures(baseline, proof.sourceFiles, proof.targetFiles)).toEqual(
      expect.arrayContaining([
        'file witness is missing baseline mounted identity: 0/controller-meta-directory//var/lib/kafka/data',
        'file witness is missing current mounted identity: 0/controller-meta-directory//var/lib/kafka/data',
      ]),
    )

    const missingCopyMarker = structuredClone(receipt)
    missingCopyMarker.copyPod.logs = missingCopyMarker.copyPod.logs.replace('\nCOPY_VERIFIED', '')
    expect(parseCopyReceipt(missingCopyMarker, baseline).failures).toContain('copy receipt is missing COPY_VERIFIED')

    const differentDigest = structuredClone(receipt)
    differentDigest.copyPod.logs = differentDigest.copyPod.logs.replace(
      `SOURCE_MANIFEST_SHA256=${'d'.repeat(64)}`,
      `SOURCE_MANIFEST_SHA256=${'b'.repeat(64)}`,
    )
    expect(parseCopyReceipt(differentDigest, baseline).failures).toContain(
      'copy receipt: source and target manifest digests differ',
    )

    const wrongDirectory = structuredClone(receipt)
    wrongDirectory.copyPod.logs = wrongDirectory.copyPod.logs.replaceAll('broker-directory', 'wrong-directory')
    expect(parseCopyReceipt(wrongDirectory, baseline).failures).toContain(
      'copy receipt: copy receipt SOURCE_META_PROPERTIES identity mismatch for kafka-log3/meta.properties: expected cluster-a/3/broker-directory',
    )
  })

  it('requires copied receipts to cover every mounted baseline identity', async () => {
    const baseline = snapshot()
    const directory = await mkdtemp(join(tmpdir(), 'kafka-copy-receipts-'))
    try {
      await writeFile(join(directory, 'kafka-pool-b-3.receipt.json'), JSON.stringify(copyReceipt(baseline)))
      const proof = await readCopyReceipts(directory, baseline)
      expect(proof.failures).toEqual(
        expect.arrayContaining([
          'copy receipts are missing node 0',
          'file witness is missing baseline mounted identity: 0/controller-meta-directory//var/lib/kafka/data',
          'file witness is missing current mounted identity: 0/controller-meta-directory//var/lib/kafka/data',
        ]),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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

  it('accepts a bounded positive controller fetch age and rejects stale or invalid age', () => {
    const baseline = snapshot()
    const healthy = structuredClone(baseline)
    healthy.quorum.maxFollowerLagTimeMs = '15'
    expect(compareSnapshots(baseline, healthy).pass).toBe(true)

    for (const age of ['10001', '-1', 'NaN']) {
      const current = structuredClone(baseline)
      current.quorum.maxFollowerLagTimeMs = age
      const report = compareSnapshots(baseline, current)
      expect(report.pass).toBe(false)
      expect(report.failures).toContain('Kafka controller quorum has follower lag or stale fetch age')
    }
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
