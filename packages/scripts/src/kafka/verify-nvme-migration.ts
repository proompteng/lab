#!/usr/bin/env bun

import { readFile, writeFile } from 'node:fs/promises'

import { ensureCli, fatal } from '../shared/cli'

const SCHEMA_VERSION = 1
const DEFAULT_NAMESPACE = 'kafka'
const KAFKA_BIN = '/opt/kafka/bin'

type JsonObject = Record<string, unknown>

export type PartitionSnapshot = {
  partition: number
  leader: number
  replicas: number[]
  isr: number[]
  startOffset: string
  endOffset: string
  logDirs: Array<{
    broker: number
    logDir: string
    sizeBytes: string
    offsetLag: string
  }>
}

export type TopicSnapshot = {
  name: string
  topicId: string
  declaredPartitionCount: number
  configs: string
  partitions: PartitionSnapshot[]
}

export type GroupOffsetSnapshot = {
  group: string
  topic: string
  partition: number
  currentOffset: string | null
  logEndOffset: string | null
  lag: string | null
}

export type StorageBinding = {
  pod: string | null
  node: string | null
  nodeId: number | null
  directoryId: string | null
  role: 'broker' | 'controller' | 'unknown'
  pvc: string
  pv: string | null
  phase: string | null
  storageClass: string | null
  provisioner: string | null
  capacity: string | null
  source: 'local' | 'csi' | 'hostPath' | 'unknown'
  path: string | null
  mountPath: string | null
  csiDriver: string | null
  nodeAffinity: JsonObject | null
}

export type NodeIdentity = {
  nodeId: number
  directoryId: string
  logEndOffset: string
  lag: string
  status: string
}

export type MetaPropertiesIdentity = {
  pod: string
  mountPath: string
  clusterId: string
  nodeId: number
  directoryId: string
}

export type NvmeEvidence = {
  schemaVersion: 1
  capturedAt?: string
  nodes: Array<{
    node: string
    mounts: Array<{
      mountpoint: string
      device: string
    }>
  }>
}

export type KafkaSnapshot = {
  schemaVersion: 1
  capturedAt: string
  context: string
  namespace: string
  clusterName: string
  pod: string
  bootstrap: string
  clusterId: string
  identities: NodeIdentity[]
  metaProperties: MetaPropertiesIdentity[]
  topics: TopicSnapshot[]
  listedTopics: string[]
  groups: GroupOffsetSnapshot[]
  quorum: {
    leaderId: number
    highWatermark: string
    maxFollowerLag: string
    maxFollowerLagTimeMs: string
    voterIds: number[]
  }
  storage: {
    bindings: StorageBinding[]
    nvmeEvidence?: NvmeEvidence
  }
}

export type RecordWitness = {
  topic: string
  partition: number
  startOffset: string
  endOffset: string
  recordCount: number
  sha256: string
}

export type FileWitness = {
  nodeId: number
  directoryId: string
  mountPath: string
  relativePath: string
  sizeBytes: string
  sha256: string
}

export type VerificationOptions = {
  requireReplicaSets?: boolean
  requiredGroups?: string[]
  exactGroups?: string[]
  requiredWitnessTopics?: string[]
  requiredNodes?: string[]
  allowOffsetAdvance?: boolean
}

export type VerificationReport = {
  schemaVersion: 1
  pass: boolean
  baselineCapturedAt: string
  currentCapturedAt: string
  failures: string[]
  warnings: string[]
  checks: {
    clusterId: boolean
    topicInventory: boolean
    partitionOffsets: boolean
    replication: boolean
    topicConfigs: boolean
    groupOffsets: boolean
    controllerQuorum: boolean
    nvmeStorage: boolean
    recordWitnesses: boolean
    fileWitnesses: boolean
  }
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null

const stringValue = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const textValue = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const numberValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const arrayValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const sorted = (values: string[]) => [...values].sort((left, right) => left.localeCompare(right))

const uniqueSorted = (values: string[]) => sorted([...new Set(values)])

const keyForPartition = (topic: string, partition: number) => `${topic}\u0000${partition}`

const keyForGroupOffset = (offset: Pick<GroupOffsetSnapshot, 'group' | 'topic' | 'partition'>) =>
  `${offset.group}\u0000${offset.topic}\u0000${offset.partition}`

const parseArgs = (argv: string[]) => {
  const out = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const trimmed = token.slice(2)
    const equals = trimmed.indexOf('=')
    let key = trimmed
    let value: string | undefined
    if (equals >= 0) {
      key = trimmed.slice(0, equals)
      value = trimmed.slice(equals + 1)
    } else {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        index += 1
      } else {
        value = 'true'
      }
    }
    const values = out.get(key) ?? []
    values.push(value)
    out.set(key, values)
  }
  return out
}

const oneArg = (args: Map<string, string[]>, name: string) => args.get(name)?.at(-1)

const manyArgs = (args: Map<string, string[]>, name: string) => args.get(name) ?? []

const boolArg = (args: Map<string, string[]>, name: string) => oneArg(args, name) === 'true'

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/kafka/verify-nvme-migration.ts --mode capture --context galactic-tailscale --output baseline.json
  bun run packages/scripts/src/kafka/verify-nvme-migration.ts --mode verify \\
    --context galactic-tailscale \\
    --baseline baseline.json --record-witness-before before.json --record-witness-after after.json \\
    --nvme-evidence nvme.json --output report.json

Modes:
  capture                             Read Kafka and Kubernetes state and write a JSON baseline.
  verify                              Capture current state, compare it with --baseline, and exit non-zero on failure.

Read-only options:
  --context <name>                    Kubernetes context (required; no implicit target)
  --namespace <name>                  Kafka namespace (default: kafka)
  --cluster <name>                    Strimzi Kafka cluster name (default: kafka)
  --bootstrap <host:port>             Unauthenticated bootstrap (default: <cluster>-kafka-bootstrap:9093)
  --pod <name>                        Kafka pod (default: first ready broker pod)
  --allow-empty-topics                Permit an empty proof cluster before its first canary record
  --command-config <remote-path>      Optional Kafka client properties path inside the pod
  --output <path>                     Capture output or verification report
  --current-output <path>             Persist the verify-phase current snapshot
  --baseline <path>                   Baseline snapshot for verify mode
  --nvme-evidence <path>              JSON Talos/read-only mount evidence (required by verify)
  --required-group <id>               Group whose committed offsets must be present and never regress (repeatable)
  --exact-group <id>                  Group whose committed offsets must remain byte-for-byte unchanged (repeatable)
  --required-witness-topic <name>     Witness must cover this topic's full baseline range (repeatable)
  --required-node <name>              Node that must own at least one verified Kafka NVMe claim (repeatable)
  --require-replica-sets              Require broker IDs in each replica set to remain unchanged
  --quiesced                          Require exact end offsets instead of allowing append-only progress
  --file-witness-before <path>        Full SHA-256 file manifest captured before target startup
  --file-witness-after <path>         Full SHA-256 file manifest captured after target startup

Record witnesses are read-only JSON files containing sha256 hashes of canonical records; the verifier never
produces a canary or stores payloads. Each record row is {topic, partition, startOffset, endOffset,
recordCount, sha256}; start/end are the exact Kafka range [startOffset,endOffset). Hash the same
offset,timestamp,key,value byte encoding before and after the quiesced cut.

File witnesses are read-only JSON files containing {nodeId, directoryId, mountPath, relativePath, sizeBytes,
sha256}. The migration must hash the data files before starting the copied pod and after startup; startup-created
quorum metadata must be excluded by the producer of the manifest, and the same scope must be used on both sides.
`.trim()

const execCapture = async (command: string, args: string[]) => {
  const subprocess = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const stdout = await new Response(subprocess.stdout).text()
  const stderr = await new Response(subprocess.stderr).text()
  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command} ${args.join(' ')}${stderr ? `\n${stderr.trim()}` : ''}`)
  }
  return stdout
}

const kubectlJson = async <T>(context: string, args: string[]): Promise<T> => {
  const output = await execCapture('kubectl', ['--context', context, ...args, '-o', 'json'])
  return JSON.parse(output) as T
}

const kubectlExec = async (context: string, namespace: string, pod: string, command: string, args: string[]) =>
  execCapture('kubectl', [
    '--context',
    context,
    '-n',
    namespace,
    'exec',
    pod,
    '-c',
    'kafka',
    '--',
    'env',
    'KAFKA_HEAP_OPTS=-Xms32m -Xmx128m',
    `${KAFKA_BIN}/${command}`,
    ...args,
  ])

const kubectlPodExec = async (context: string, namespace: string, pod: string, args: string[]) =>
  execCapture('kubectl', ['--context', context, '-n', namespace, 'exec', pod, '-c', 'kafka', '--', ...args])

const kafkaArgs = (bootstrap: string, commandConfig?: string, args: string[] = []) => {
  const result = ['--bootstrap-server', bootstrap]
  if (commandConfig) result.push('--command-config', commandConfig)
  result.push(...args)
  return result
}

const kafkaCommand = (
  namespace: string,
  pod: string,
  context: string,
  bootstrap: string,
  commandConfig: string | undefined,
  command: string,
  args: string[],
) => kubectlExec(context, namespace, pod, command, kafkaArgs(bootstrap, commandConfig, args))

const kafkaClusterId = (context: string, namespace: string, pod: string, bootstrap: string, commandConfig?: string) => {
  const args = ['cluster-id', '--bootstrap-server', bootstrap]
  if (commandConfig) args.push('--command-config', commandConfig)
  return kubectlExec(context, namespace, pod, 'kafka-cluster.sh', args)
}

export const parseMetaProperties = (output: string, pod: string, mountPath: string): MetaPropertiesIdentity => {
  const properties = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = /^([^#=\s]+)=(.*)$/.exec(line.trim())
    if (match) properties.set(match[1], match[2])
  }
  const clusterId = properties.get('cluster.id')
  const nodeIdText = properties.get('node.id')
  const directoryId = properties.get('directory.id')
  const nodeId = nodeIdText === undefined ? null : Number(nodeIdText)
  if (!clusterId || !directoryId || nodeId === null || !Number.isInteger(nodeId) || nodeId < 0) {
    throw new Error(`Kafka meta.properties is missing cluster.id, node.id, or directory.id for ${pod}:${mountPath}`)
  }
  return { pod, mountPath, clusterId, nodeId, directoryId }
}

const pickKafkaPod = (value: unknown, requestedPod?: string) => {
  if (requestedPod) return requestedPod
  const items = isObject(value) ? arrayValue(value.items) : []
  const readyBrokers = items
    .map((item) => (isObject(item) ? item : {}))
    .filter((item) => {
      const metadata = isObject(item.metadata) ? item.metadata : {}
      const labels = isObject(metadata.labels) ? metadata.labels : {}
      const status = isObject(item.status) ? item.status : {}
      const conditions = arrayValue(status.conditions)
      return (
        metadata.name !== undefined &&
        labels['strimzi.io/broker-role'] === 'true' &&
        status.phase === 'Running' &&
        conditions.some((condition) => isObject(condition) && condition.type === 'Ready' && condition.status === 'True')
      )
    })
    .map((item) => stringValue(isObject(item.metadata) ? item.metadata.name : undefined))
    .filter((name): name is string => name !== null)
    .sort((left, right) => left.localeCompare(right))
  if (readyBrokers[0]) return readyBrokers[0]
  throw new Error('No ready Kafka broker pod was found')
}

const parseTopicConfigs = (value: string) => {
  const match = /\bConfigs:\s*(.*)$/.exec(value)
  return normalizeTopicConfigs(match?.[1] ?? '')
}

const normalizeTopicConfigs = (value: string) =>
  value
    .split(/,(?=[^=,\s]+=)/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .join(',')

export const parseTopicDescribe = (output: string): TopicSnapshot[] => {
  const topics = new Map<string, TopicSnapshot>()
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('Topic: ')) continue
    const header = /^Topic:\s+(\S+)\s+TopicId:\s+(\S+)\s+PartitionCount:\s+(\d+)\s+ReplicationFactor:\s+(\d+)/.exec(
      line,
    )
    if (header) {
      const [, name, topicId, partitionCountText] = header
      const declaredPartitionCount = Number(partitionCountText)
      const existing = topics.get(name)
      if (existing) throw new Error(`Kafka topic describe repeated header for ${name}`)
      const current = { name, topicId, declaredPartitionCount, configs: '', partitions: [] }
      current.topicId = topicId
      current.configs = parseTopicConfigs(line)
      topics.set(name, current)
      continue
    }
    const partition =
      /^Topic:\s+(\S+)\s+Partition:\s+(\d+)\s+Leader:\s+(\S+)\s+Replicas:\s+(\S+)\s+Isr:\s*(.*?)\s+Elr:/.exec(line)
    if (!partition) throw new Error(`Kafka topic describe contains a malformed row: ${line}`)
    const [, name, partitionText, leaderText, replicasText, isrText] = partition
    const current = topics.get(name)
    if (!current) throw new Error(`Kafka topic describe partition has no header: ${name}`)
    const partitionId = Number(partitionText)
    const leader = leaderText === 'none' ? -1 : Number(leaderText)
    if (!Number.isInteger(leader) || !Number.isInteger(partitionId)) {
      throw new Error(`Kafka topic describe contains a malformed row: ${line}`)
    }
    if (current.partitions.some((existing) => existing.partition === partitionId)) {
      throw new Error(`Kafka topic describe repeated ${name}[${partitionId}]`)
    }
    current.partitions.push({
      partition: partitionId,
      leader,
      replicas: replicasText
        .split(',')
        .filter(Boolean)
        .map(Number)
        .sort((left, right) => left - right),
      isr: isrText
        .split(',')
        .filter(Boolean)
        .map(Number)
        .sort((left, right) => left - right),
      startOffset: '',
      endOffset: '',
      logDirs: [],
    })
  }
  const parsedTopics = [...topics.values()]
    .map((topic) => ({
      ...topic,
      partitions: topic.partitions.sort((left, right) => left.partition - right.partition),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const topic of parsedTopics) {
    const expected = Array.from({ length: topic.declaredPartitionCount }, (_, partition) => partition)
    const actual = topic.partitions.map((partition) => partition.partition)
    if (actual.length !== topic.declaredPartitionCount || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Kafka topic describe partition inventory is incomplete for ${topic.name}: declared ${topic.declaredPartitionCount}, parsed ${actual.join(',') || 'none'}`,
      )
    }
  }
  return parsedTopics
}

export const validateTopicInventory = (listedTopics: string[], topics: TopicSnapshot[]) => {
  const normalizedListedTopics = listedTopics
    .map((topic) => topic.trim())
    .filter(Boolean)
    .sort()
  if (new Set(normalizedListedTopics).size !== normalizedListedTopics.length) {
    throw new Error('Kafka --list returned duplicate topic names')
  }
  const describedTopics = topics.map((topic) => topic.name).sort()
  if (JSON.stringify(normalizedListedTopics) !== JSON.stringify(describedTopics)) {
    throw new Error('Kafka --list and --describe topic inventories disagree')
  }
  return normalizedListedTopics
}

const parseOffsetOutput = (output: string) => {
  const offsets = new Map<string, string>()
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    const match = /^(.*):(\d+):(-?\d+)$/.exec(line)
    if (!match) continue
    offsets.set(keyForPartition(match[1], Number(match[2])), match[3])
  }
  return offsets
}

const parseGroupOffsets = (output: string): GroupOffsetSnapshot[] => {
  const result: GroupOffsetSnapshot[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('GROUP ') || line.startsWith('Consumer group')) continue
    const fields = line.split(/\s+/)
    if (fields.length < 6 || !/^\d+$/.test(fields[2])) continue
    const value = (field: string | undefined) => (field === undefined || field === '-' ? null : field)
    result.push({
      group: fields[0],
      topic: fields[1],
      partition: Number(fields[2]),
      currentOffset: value(fields[3]),
      logEndOffset: value(fields[4]),
      lag: value(fields[5]),
    })
  }
  return result.sort((left, right) => keyForGroupOffset(left).localeCompare(keyForGroupOffset(right)))
}

const parseQuorumStatus = (output: string): KafkaSnapshot['quorum'] => {
  const fields = new Map<string, string>()
  for (const rawLine of output.split('\n')) {
    const match = /^([^:]+):\s*(.*)$/.exec(rawLine.trim())
    if (match) fields.set(match[1], match[2])
  }
  const required = (name: string) => {
    const value = fields.get(name)
    if (value === undefined) throw new Error(`Kafka quorum output is missing ${name}`)
    return value
  }
  const numberField = (name: string) => {
    const value = Number(required(name))
    if (!Number.isInteger(value)) throw new Error(`Kafka quorum field ${name} is not an integer`)
    return value
  }
  const voterValue = JSON.parse(required('CurrentVoters')) as unknown
  const voterIds = arrayValue(voterValue)
    .map((voter) => (isObject(voter) ? numberValue(voter.id) : null))
    .filter((id): id is number => id !== null)
    .sort((left, right) => left - right)
  return {
    leaderId: numberField('LeaderId'),
    highWatermark: required('HighWatermark'),
    maxFollowerLag: required('MaxFollowerLag'),
    maxFollowerLagTimeMs: required('MaxFollowerLagTimeMs'),
    voterIds,
  }
}

const parseQuorumReplication = (output: string): NodeIdentity[] => {
  const identities: NodeIdentity[] = []
  for (const rawLine of output.split('\n')) {
    const fields = rawLine.trim().split(/\s+/)
    if (fields.length < 7 || !/^\d+$/.test(fields[0])) continue
    identities.push({
      nodeId: Number(fields[0]),
      directoryId: fields[1],
      logEndOffset: fields[2],
      lag: fields[3],
      status: fields[6],
    })
  }
  return identities.sort((left, right) => left.nodeId - right.nodeId)
}

const parseLogDirs = (output: string) => {
  const firstBrace = output.indexOf('{')
  const lastBrace = output.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) return new Map<string, PartitionSnapshot['logDirs']>()
  const parsed = JSON.parse(output.slice(firstBrace, lastBrace + 1)) as unknown
  const result = new Map<string, PartitionSnapshot['logDirs']>()
  const brokers = isObject(parsed) ? arrayValue(parsed.brokers) : []
  for (const brokerValue of brokers) {
    if (!isObject(brokerValue)) continue
    const broker = numberValue(brokerValue.broker)
    if (broker === null) continue
    const logDirs = arrayValue(brokerValue.logDirs)
    for (const logDirValue of logDirs) {
      if (!isObject(logDirValue)) continue
      const logDir = stringValue(logDirValue.logDir)
      if (!logDir) continue
      for (const partitionValue of arrayValue(logDirValue.partitions)) {
        if (!isObject(partitionValue)) continue
        const partitionName = stringValue(partitionValue.partition)
        const sizeBytes = textValue(partitionValue.size)
        const offsetLag = textValue(partitionValue.offsetLag)
        if (!partitionName || sizeBytes === null || offsetLag === null) continue
        const match = /^(.*)-(\d+)$/.exec(partitionName)
        if (!match) continue
        const key = keyForPartition(match[1], Number(match[2]))
        const entries = result.get(key) ?? []
        entries.push({ broker, logDir, sizeBytes, offsetLag })
        result.set(key, entries)
      }
    }
  }
  for (const entries of result.values()) entries.sort((left, right) => left.broker - right.broker)
  return result
}

const objectList = (value: unknown) => (isObject(value) ? arrayValue(value.items).filter(isObject) : [])

const storageBindings = (resources: {
  pods: unknown
  pvcs: unknown
  pvs: unknown
  storageClasses: unknown
  clusterName: string
}): StorageBinding[] => {
  const pvcItems = objectList(resources.pvcs)
  const pvItems = objectList(resources.pvs)
  const storageClassItems = objectList(resources.storageClasses)
  const podItems = objectList(resources.pods)
  const pvcByName = new Map<string, JsonObject>()
  for (const pvc of pvcItems) {
    const metadata = isObject(pvc.metadata) ? pvc.metadata : {}
    const name = stringValue(metadata.name)
    if (name) pvcByName.set(name, pvc)
  }
  const pvByName = new Map<string, JsonObject>()
  for (const pv of pvItems) {
    const metadata = isObject(pv.metadata) ? pv.metadata : {}
    const name = stringValue(metadata.name)
    if (name) pvByName.set(name, pv)
  }
  const scByName = new Map<string, JsonObject>()
  for (const storageClass of storageClassItems) {
    const metadata = isObject(storageClass.metadata) ? storageClass.metadata : {}
    const name = stringValue(metadata.name)
    if (name) scByName.set(name, storageClass)
  }
  const mounted = new Map<
    string,
    { pod: string; node: string | null; nodeId: number | null; role: StorageBinding['role']; mountPath: string | null }
  >()
  for (const pod of podItems) {
    const metadata = isObject(pod.metadata) ? pod.metadata : {}
    const podName = stringValue(metadata.name)
    if (!podName) continue
    const labels = isObject(metadata.labels) ? metadata.labels : {}
    const role: StorageBinding['role'] =
      labels['strimzi.io/broker-role'] === 'true'
        ? 'broker'
        : labels['strimzi.io/controller-role'] === 'true'
          ? 'controller'
          : 'unknown'
    const spec = isObject(pod.spec) ? pod.spec : {}
    const node = stringValue(spec.nodeName)
    const nodeIdMatch = /(\d+)$/.exec(podName)
    const nodeId = nodeIdMatch ? Number(nodeIdMatch[1]) : null
    const mountPaths = new Map<string, string>()
    for (const container of arrayValue(spec.containers)) {
      if (!isObject(container)) continue
      for (const mount of arrayValue(container.volumeMounts)) {
        if (!isObject(mount)) continue
        const volumeName = stringValue(mount.name)
        const mountPath = stringValue(mount.mountPath)
        if (volumeName && mountPath) mountPaths.set(volumeName, mountPath)
      }
    }
    for (const volume of arrayValue(spec.volumes)) {
      if (!isObject(volume)) continue
      const volumeName = stringValue(volume.name)
      const claim = isObject(volume.persistentVolumeClaim) ? stringValue(volume.persistentVolumeClaim.claimName) : null
      if (claim) {
        mounted.set(claim, {
          pod: podName,
          node,
          nodeId,
          role,
          mountPath: volumeName ? (mountPaths.get(volumeName) ?? null) : null,
        })
      }
    }
  }
  const names = new Set<string>(mounted.keys())
  for (const pvc of pvcItems) {
    const metadata = isObject(pvc.metadata) ? pvc.metadata : {}
    const labels = isObject(metadata.labels) ? metadata.labels : {}
    if (labels['strimzi.io/cluster'] === resources.clusterName) {
      const name = stringValue(metadata.name)
      if (name) names.add(name)
    }
  }
  const bindings: StorageBinding[] = []
  for (const pvcName of names) {
    const pvc = pvcByName.get(pvcName)
    if (!pvc) continue
    const metadata = isObject(pvc.metadata) ? pvc.metadata : {}
    const spec = isObject(pvc.spec) ? pvc.spec : {}
    const status = isObject(pvc.status) ? pvc.status : {}
    const storageClass = stringValue(spec.storageClassName)
    const pvName = stringValue(spec.volumeName)
    const pv = pvName ? pvByName.get(pvName) : undefined
    const pvSpec = pv && isObject(pv.spec) ? pv.spec : {}
    const storageClassObject = storageClass ? scByName.get(storageClass) : undefined
    const provisioner = storageClassObject ? stringValue(storageClassObject.provisioner) : null
    const local = isObject(pvSpec.local) ? stringValue(pvSpec.local.path) : null
    const hostPath = isObject(pvSpec.hostPath) ? stringValue(pvSpec.hostPath.path) : null
    const csi = isObject(pvSpec.csi) ? pvSpec.csi : {}
    const csiDriver = stringValue(csi.driver)
    const mountedInfo = mounted.get(pvcName)
    const labels = isObject(metadata.labels) ? metadata.labels : {}
    bindings.push({
      pod: mountedInfo?.pod ?? null,
      node: mountedInfo?.node ?? null,
      nodeId: mountedInfo?.nodeId ?? null,
      directoryId: null,
      role:
        mountedInfo?.role ??
        (labels['strimzi.io/broker-role'] === 'true'
          ? 'broker'
          : labels['strimzi.io/controller-role'] === 'true'
            ? 'controller'
            : 'unknown'),
      pvc: pvcName,
      pv: pvName,
      phase: stringValue(status.phase),
      storageClass,
      provisioner,
      capacity: isObject(pvSpec.capacity) ? stringValue(pvSpec.capacity.storage) : null,
      source: local ? 'local' : csiDriver ? 'csi' : hostPath ? 'hostPath' : 'unknown',
      path: local ?? hostPath,
      mountPath: mountedInfo?.mountPath ?? null,
      csiDriver,
      nodeAffinity: isObject(pvSpec.nodeAffinity) ? pvSpec.nodeAffinity : null,
    })
  }
  return bindings.sort((left, right) => left.pvc.localeCompare(right.pvc))
}

const collectMetaProperties = async (
  context: string,
  namespace: string,
  bindings: StorageBinding[],
): Promise<MetaPropertiesIdentity[]> => {
  const mounts = new Map<string, { pod: string; mountPath: string }>()
  for (const binding of bindings) {
    if (!binding.pod || !binding.mountPath) {
      throw new Error(`Kafka PVC ${binding.pvc} has no mounted pod/data path for meta.properties capture`)
    }
    const mountPath = binding.mountPath.replace(/\/+$/, '')
    mounts.set(`${binding.pod}\u0000${mountPath}`, { pod: binding.pod, mountPath })
  }
  const identities = await Promise.all(
    [...mounts.values()].map(async ({ pod, mountPath }) => {
      const nodeIdHint = /(\d+)$/.exec(pod)?.[1]
      const candidate = nodeIdHint ? `${mountPath}/kafka-log${nodeIdHint}/meta.properties` : null
      let metaPath = candidate
      let output: string
      try {
        if (!candidate) throw new Error('pod has no node ID suffix')
        output = await kubectlPodExec(context, namespace, pod, ['cat', candidate])
      } catch {
        const discovered = await kubectlPodExec(context, namespace, pod, [
          'find',
          mountPath,
          '-maxdepth',
          '4',
          '-type',
          'f',
          '-name',
          'meta.properties',
          '-print',
        ])
        const paths = discovered
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.endsWith('/meta.properties'))
        if (paths.length !== 1) throw new Error(`Expected one meta.properties under ${mountPath} for ${pod}`)
        metaPath = paths[0]
        output = await kubectlPodExec(context, namespace, pod, ['cat', metaPath])
      }
      if (!metaPath || !metaPath.startsWith(`${mountPath}/`)) {
        throw new Error(`meta.properties for ${pod} is outside mounted data path ${mountPath}`)
      }
      return parseMetaProperties(output, pod, mountPath)
    }),
  )
  const nodeIds = identities.map((identity) => identity.nodeId)
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error('Kafka meta.properties contains duplicate node IDs')
  return identities.sort((left, right) => left.nodeId - right.nodeId)
}

const attachMetaIdentities = (bindings: StorageBinding[], identities: MetaPropertiesIdentity[]) => {
  const identityByMount = new Map(
    identities.map((identity) => [`${identity.pod}\u0000${identity.mountPath}`, identity]),
  )
  for (const binding of bindings) {
    const key = `${binding.pod ?? ''}\u0000${binding.mountPath ?? ''}`
    const identity = identityByMount.get(key)
    binding.nodeId = identity?.nodeId ?? null
    binding.directoryId = identity?.directoryId ?? null
  }
}

const attachOffsets = (
  topics: TopicSnapshot[],
  starts: Map<string, string>,
  ends: Map<string, string>,
  logDirs: Map<string, PartitionSnapshot['logDirs']>,
) => {
  for (const topic of topics) {
    for (const partition of topic.partitions) {
      const key = keyForPartition(topic.name, partition.partition)
      const startOffset = starts.get(key)
      const endOffset = ends.get(key)
      if (startOffset === undefined || endOffset === undefined) {
        throw new Error(`Kafka offsets are missing for ${topic.name}[${partition.partition}]`)
      }
      partition.startOffset = startOffset
      partition.endOffset = endOffset
      partition.logDirs = logDirs.get(key) ?? []
    }
  }
}

const collectSnapshot = async (options: {
  context: string
  namespace: string
  clusterName: string
  bootstrap: string
  pod?: string
  commandConfig?: string
  nvmeEvidence?: NvmeEvidence
  allowEmptyTopics?: boolean
}): Promise<KafkaSnapshot> => {
  const pods = await kubectlJson<unknown>(options.context, [
    '-n',
    options.namespace,
    'get',
    'pods',
    '-l',
    `strimzi.io/cluster=${options.clusterName}`,
  ])
  const pod = pickKafkaPod(pods, options.pod)
  const [pvcs, pvs, storageClasses] = await Promise.all([
    kubectlJson<unknown>(options.context, ['-n', options.namespace, 'get', 'pvc']),
    kubectlJson<unknown>(options.context, ['get', 'pv']),
    kubectlJson<unknown>(options.context, ['get', 'storageclass']),
  ])
  const topicDescribe = await kafkaCommand(
    options.namespace,
    pod,
    options.context,
    options.bootstrap,
    options.commandConfig,
    'kafka-topics.sh',
    ['--describe'],
  )
  const listedTopics = await kafkaCommand(
    options.namespace,
    pod,
    options.context,
    options.bootstrap,
    options.commandConfig,
    'kafka-topics.sh',
    ['--list'],
  )
  const clusterIdOutput = await kafkaClusterId(
    options.context,
    options.namespace,
    pod,
    options.bootstrap,
    options.commandConfig,
  )
  const quorumOutput = await kafkaCommand(
    options.namespace,
    pod,
    options.context,
    options.bootstrap,
    options.commandConfig,
    'kafka-metadata-quorum.sh',
    ['describe', '--status'],
  )
  const quorumReplicationOutput = await kafkaCommand(
    options.namespace,
    pod,
    options.context,
    options.bootstrap,
    options.commandConfig,
    'kafka-metadata-quorum.sh',
    ['describe', '--replication'],
  )
  const topics = parseTopicDescribe(topicDescribe)
  const normalizedListedTopics = validateTopicInventory(
    listedTopics
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    topics,
  )
  if (topics.length === 0 && !options.allowEmptyTopics) throw new Error('Kafka topic describe returned no topics')
  const brokerIds = uniqueSorted(
    topics.flatMap((topic) => topic.partitions.flatMap((partition) => partition.replicas.map(String))),
  )
  const brokerList = brokerIds.join(',')
  const logDirsArgs = ['--describe', ...(brokerList ? ['--broker-list', brokerList] : [])]
  const startsOutput = topics.length
    ? await kafkaCommand(
        options.namespace,
        pod,
        options.context,
        options.bootstrap,
        options.commandConfig,
        'kafka-get-offsets.sh',
        ['--time', '-2'],
      )
    : ''
  const endsOutput = topics.length
    ? await kafkaCommand(
        options.namespace,
        pod,
        options.context,
        options.bootstrap,
        options.commandConfig,
        'kafka-get-offsets.sh',
        ['--time', '-1'],
      )
    : ''
  const groupsOutput = topics.length
    ? await kafkaCommand(
        options.namespace,
        pod,
        options.context,
        options.bootstrap,
        options.commandConfig,
        'kafka-consumer-groups.sh',
        ['--all-groups', '--describe', '--offsets'],
      )
    : ''
  const logDirsOutput = topics.length
    ? await kafkaCommand(
        options.namespace,
        pod,
        options.context,
        options.bootstrap,
        options.commandConfig,
        'kafka-log-dirs.sh',
        logDirsArgs,
      )
    : ''
  const starts = parseOffsetOutput(startsOutput)
  const ends = parseOffsetOutput(endsOutput)
  const logDirs = parseLogDirs(logDirsOutput)
  attachOffsets(topics, starts, ends, logDirs)
  const clusterMatch = /Cluster\s+ID:\s*(\S+)/i.exec(clusterIdOutput)
  if (!clusterMatch) throw new Error('Kafka cluster-id output did not contain ClusterId')
  const identities = parseQuorumReplication(quorumReplicationOutput)
  const bindingResources = storageBindings({ pods, pvcs, pvs, storageClasses, clusterName: options.clusterName })
  const metaProperties = await collectMetaProperties(options.context, options.namespace, bindingResources)
  attachMetaIdentities(bindingResources, metaProperties)
  return {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    context: options.context,
    namespace: options.namespace,
    clusterName: options.clusterName,
    pod,
    bootstrap: options.bootstrap,
    clusterId: clusterMatch[1],
    identities,
    metaProperties,
    topics,
    listedTopics: normalizedListedTopics,
    groups: parseGroupOffsets(groupsOutput),
    quorum: parseQuorumStatus(quorumOutput),
    storage: {
      bindings: bindingResources,
      ...(options.nvmeEvidence ? { nvmeEvidence: options.nvmeEvidence } : {}),
    },
  }
}

const topicMap = (snapshot: KafkaSnapshot) => new Map(snapshot.topics.map((topic) => [topic.name, topic]))

const partitionMap = (topic: TopicSnapshot) =>
  new Map(topic.partitions.map((partition) => [partition.partition, partition]))

const groupMap = (snapshot: KafkaSnapshot) => new Map(snapshot.groups.map((group) => [keyForGroupOffset(group), group]))

const compareOffsetValues = (left: string | null, right: string | null) => {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  try {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  } catch {
    return left.localeCompare(right)
  }
}

export const compareRecordWitnesses = (before: RecordWitness[], after: RecordWitness[]) => {
  const failures: string[] = []
  if (before.length === 0 || after.length === 0) {
    failures.push('record witness set is empty; preserved records are unproven')
    return failures
  }
  const beforeMap = new Map(before.map((record) => [`${record.topic}\u0000${record.partition}`, record]))
  const afterMap = new Map(after.map((record) => [`${record.topic}\u0000${record.partition}`, record]))
  for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const left = beforeMap.get(key)
    const right = afterMap.get(key)
    if (!left || !right) {
      failures.push(`record witness coverage changed for ${key.replace('\u0000', '/p')}`)
      continue
    }
    for (const field of ['startOffset', 'endOffset', 'recordCount', 'sha256'] as const) {
      if (left[field] !== right[field]) failures.push(`record witness ${key.replace('\u0000', '/p')} ${field} changed`)
    }
  }
  return failures
}

export const recordWitnessCoverageFailures = (
  snapshot: KafkaSnapshot,
  records: RecordWitness[],
  requiredTopics: string[],
) => {
  const failures: string[] = []
  if (requiredTopics.length === 0) {
    return ['record witness topic scope is empty; pass --required-witness-topic explicitly']
  }
  const topics = topicMap(snapshot)
  const requiredTopicSet = new Set(requiredTopics)
  const witnessMap = new Map(records.map((record) => [keyForPartition(record.topic, record.partition), record]))
  for (const record of records) {
    if (!requiredTopicSet.has(record.topic)) {
      failures.push(`record witness topic is outside the required scope: ${record.topic}`)
    }
  }
  for (const topicName of requiredTopics) {
    const topic = topics.get(topicName)
    if (!topic) {
      failures.push(`required record-witness topic is absent: ${topicName}`)
      continue
    }
    for (const partition of topic.partitions) {
      const key = keyForPartition(topic.name, partition.partition)
      const witness = witnessMap.get(key)
      if (!witness) {
        failures.push(`record witness is missing ${topic.name}[${partition.partition}]`)
        continue
      }
      if (witness.startOffset !== partition.startOffset || witness.endOffset !== partition.endOffset) {
        failures.push(`record witness range does not cover ${topic.name}[${partition.partition}] baseline offsets`)
      }
    }
  }
  return failures
}

export const compareFileWitnesses = (before: FileWitness[], after: FileWitness[]) => {
  const failures: string[] = []
  if (before.length === 0 || after.length === 0) {
    failures.push('file witness set is empty; copied data is unproven')
    return failures
  }
  const keyForFile = (file: FileWitness) =>
    `${file.nodeId}\u0000${file.directoryId}\u0000${file.mountPath}\u0000${file.relativePath}`
  const beforeMap = new Map(before.map((file) => [keyForFile(file), file]))
  const afterMap = new Map(after.map((file) => [keyForFile(file), file]))
  for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const left = beforeMap.get(key)
    const right = afterMap.get(key)
    if (!left || !right) {
      failures.push(`file witness coverage changed for ${key.replaceAll('\u0000', '/')}`)
      continue
    }
    if (left.sizeBytes !== right.sizeBytes || left.sha256 !== right.sha256) {
      failures.push(`file witness hash changed for ${key.replaceAll('\u0000', '/')}`)
    }
  }
  return failures
}

export const fileWitnessCoverageFailures = (baseline: KafkaSnapshot, before: FileWitness[], after: FileWitness[]) => {
  const failures: string[] = []
  const identityKey = (nodeId: number, directoryId: string, mountPath: string) =>
    `${nodeId}\u0000${directoryId}\u0000${mountPath}`
  const expected = new Set(
    baseline.metaProperties.map((identity) => identityKey(identity.nodeId, identity.directoryId, identity.mountPath)),
  )
  if (expected.size === 0) return ['file witness identity scope is empty; mounted Kafka identities are unproven']
  const beforeIdentities = new Set(before.map((file) => identityKey(file.nodeId, file.directoryId, file.mountPath)))
  const afterIdentities = new Set(after.map((file) => identityKey(file.nodeId, file.directoryId, file.mountPath)))
  for (const file of [...before, ...after]) {
    const key = identityKey(file.nodeId, file.directoryId, file.mountPath)
    if (!expected.has(key)) {
      failures.push(`file witness identity is outside mounted Kafka scope: ${file.nodeId}/${file.mountPath}`)
    }
  }
  for (const key of expected) {
    if (!beforeIdentities.has(key))
      failures.push(`file witness is missing baseline mounted identity: ${key.replaceAll('\u0000', '/')}`)
    if (!afterIdentities.has(key))
      failures.push(`file witness is missing current mounted identity: ${key.replaceAll('\u0000', '/')}`)
  }
  return failures
}

const storageNvmeFailures = (snapshot: KafkaSnapshot, requiredNodes: string[]) => {
  const failures: string[] = []
  const bindings = snapshot.storage.bindings
  const evidence = snapshot.storage.nvmeEvidence
  if (!evidence) return ['NVMe evidence is missing from the verification snapshot']
  const evidenceByNode = new Map(evidence.nodes.map((node) => [node.node, node.mounts]))
  for (const binding of bindings) {
    if (binding.phase !== 'Bound') failures.push(`Kafka PVC ${binding.pvc} is not Bound`)
    const storageClass = `${binding.storageClass ?? ''} ${binding.provisioner ?? ''}`.toLowerCase()
    if (storageClass.includes('ceph') || storageClass.includes('rook')) {
      failures.push(
        `Kafka PVC ${binding.pvc} still uses Ceph storage (${binding.storageClass ?? binding.provisioner ?? 'unknown'})`,
      )
    }
    if (!binding.node || !binding.path) {
      failures.push(`Kafka PVC ${binding.pvc} has no local node/path mapping`)
      continue
    }
    if (binding.nodeId === null || !binding.directoryId || !binding.mountPath) {
      failures.push(`Kafka PVC ${binding.pvc} is missing stable node, directory, or mount identity`)
    }
    const mounts = evidenceByNode.get(binding.node) ?? []
    const matchingMount = mounts
      .filter(
        (mount) =>
          binding.path === mount.mountpoint || binding.path?.startsWith(`${mount.mountpoint.replace(/\/+$/, '')}/`),
      )
      .sort((left, right) => right.mountpoint.length - left.mountpoint.length)[0]
    if (!matchingMount) {
      failures.push(`Kafka PVC ${binding.pvc} path ${binding.path} is not covered by NVMe evidence on ${binding.node}`)
      continue
    }
    if (!/(^|[/])nvme[0-9]|nvme[-_]/i.test(matchingMount.device)) {
      failures.push(`Kafka PVC ${binding.pvc} maps to non-NVMe device ${matchingMount.device}`)
    }
  }
  const nodes = new Set(bindings.map((binding) => binding.node).filter((node): node is string => node !== null))
  for (const node of requiredNodes) {
    if (!nodes.has(node)) failures.push(`required Kafka NVMe node is absent: ${node}`)
  }
  return failures
}

export const compareSnapshots = (
  baseline: KafkaSnapshot,
  current: KafkaSnapshot,
  options: VerificationOptions = {},
): VerificationReport => {
  const failures: string[] = []
  const warnings: string[] = []
  const checks = {
    clusterId: baseline.clusterId === current.clusterId,
    topicInventory: true,
    partitionOffsets: true,
    replication: true,
    topicConfigs: true,
    groupOffsets: true,
    controllerQuorum: true,
    nvmeStorage: true,
    recordWitnesses: true,
    fileWitnesses: true,
  }
  if (!checks.clusterId) {
    failures.push(`Kafka cluster ID changed (${baseline.clusterId} -> ${current.clusterId})`)
  }
  const baselinePartitionCount = baseline.topics.reduce((total, topic) => total + topic.partitions.length, 0)
  const currentPartitionCount = current.topics.reduce((total, topic) => total + topic.partitions.length, 0)
  if (baselinePartitionCount === 0 || currentPartitionCount === 0) {
    checks.partitionOffsets = false
    failures.push('Kafka snapshot contains zero parsed partitions; migration data is unproven')
  }
  const baselineIdentities = new Map(baseline.identities.map((identity) => [identity.nodeId, identity]))
  const currentIdentities = new Map(current.identities.map((identity) => [identity.nodeId, identity]))
  if (baselineIdentities.size !== currentIdentities.size) {
    checks.controllerQuorum = false
    failures.push('Kafka node identity inventory changed')
  }
  for (const nodeId of baselineIdentities.keys()) {
    const after = currentIdentities.get(nodeId)
    if (!after) {
      checks.controllerQuorum = false
      failures.push(`Kafka node identity disappeared: ${nodeId}`)
      continue
    }
    if (after.lag !== '0') {
      checks.controllerQuorum = false
      failures.push(`Kafka node ${nodeId} has replication lag ${after.lag}`)
    }
  }
  const baselineMeta = new Map(baseline.metaProperties.map((identity) => [identity.nodeId, identity]))
  const currentMeta = new Map(current.metaProperties.map((identity) => [identity.nodeId, identity]))
  if (baselineMeta.size === 0 || currentMeta.size === 0 || baselineMeta.size !== currentMeta.size) {
    checks.controllerQuorum = false
    failures.push('Kafka meta.properties identity inventory is empty or changed')
  }
  for (const [nodeId, before] of baselineMeta) {
    const after = currentMeta.get(nodeId)
    if (!after) {
      checks.controllerQuorum = false
      failures.push(`Kafka meta.properties identity disappeared for node ${nodeId}`)
      continue
    }
    if (before.clusterId !== baseline.clusterId || after.clusterId !== current.clusterId) {
      checks.clusterId = false
      failures.push(`Kafka meta.properties cluster ID disagrees for node ${nodeId}`)
    }
    if (before.directoryId !== after.directoryId) {
      checks.controllerQuorum = false
      failures.push(`Kafka meta.properties directory ID changed for node ${nodeId}`)
    }
    if (before.mountPath !== after.mountPath) {
      checks.controllerQuorum = false
      failures.push(`Kafka meta.properties mount path changed for node ${nodeId}`)
    }
  }
  const baselineBindings = new Map(baseline.storage.bindings.map((binding) => [binding.pvc, binding]))
  const currentBindings = new Map(current.storage.bindings.map((binding) => [binding.pvc, binding]))
  if (baselineBindings.size !== currentBindings.size) {
    checks.nvmeStorage = false
    failures.push('Kafka durable PVC inventory changed')
  }
  for (const [pvc, before] of baselineBindings) {
    const after = currentBindings.get(pvc)
    if (!after) {
      checks.nvmeStorage = false
      failures.push(`Kafka durable PVC disappeared: ${pvc}`)
      continue
    }
    if (before.nodeId !== after.nodeId) {
      checks.nvmeStorage = false
      failures.push(`Kafka node ID mapping changed for PVC ${pvc}`)
    }
    if (before.directoryId !== after.directoryId) {
      checks.nvmeStorage = false
      failures.push(`Kafka directory ID mapping changed for PVC ${pvc}`)
    }
    if (before.mountPath !== after.mountPath) {
      checks.nvmeStorage = false
      failures.push(`Kafka mount path changed for PVC ${pvc}`)
    }
  }
  const baselineTopics = topicMap(baseline)
  const currentTopics = topicMap(current)
  const baselineTopicNames = sorted([...baselineTopics.keys()])
  const currentTopicNames = sorted([...currentTopics.keys()])
  if (JSON.stringify(baselineTopicNames) !== JSON.stringify(currentTopicNames)) {
    checks.topicInventory = false
    failures.push('Kafka topic inventory changed')
  }
  if (JSON.stringify(baseline.listedTopics) !== JSON.stringify(current.listedTopics)) {
    checks.topicInventory = false
    failures.push('Kafka --list inventory disagrees with the baseline')
  }
  for (const topicName of baselineTopicNames) {
    const before = baselineTopics.get(topicName)
    const after = currentTopics.get(topicName)
    if (!before || !after) continue
    if (before.topicId !== after.topicId) {
      checks.topicInventory = false
      failures.push(`Kafka topic ID changed for ${topicName}`)
    }
    if (before.configs !== after.configs) {
      checks.topicConfigs = false
      failures.push(`Kafka topic configs changed for ${topicName}`)
    }
    const beforePartitions = partitionMap(before)
    const afterPartitions = partitionMap(after)
    if (beforePartitions.size !== afterPartitions.size) {
      checks.partitionOffsets = false
      failures.push(`Kafka partition count changed for ${topicName}`)
    }
    for (const partitionId of new Set([...beforePartitions.keys(), ...afterPartitions.keys()])) {
      const left = beforePartitions.get(partitionId)
      const right = afterPartitions.get(partitionId)
      if (!left || !right) {
        checks.partitionOffsets = false
        failures.push(`Kafka partition inventory changed for ${topicName}[${partitionId}]`)
        continue
      }
      const offsetAdvanced =
        (options.allowOffsetAdvance ?? true) && compareOffsetValues(right.endOffset, left.endOffset) >= 0
      if (left.startOffset !== right.startOffset || (!offsetAdvanced && left.endOffset !== right.endOffset)) {
        checks.partitionOffsets = false
        failures.push(`Kafka offsets changed for ${topicName}[${partitionId}]`)
      }
      if (left.isr.length !== left.replicas.length) {
        checks.replication = false
        failures.push(`Kafka baseline replication/ISR was not fully healthy for ${topicName}[${partitionId}]`)
      }
      if (left.replicas.length !== right.replicas.length || right.isr.length !== right.replicas.length) {
        checks.replication = false
        failures.push(`Kafka replication/ISR is not fully healthy for ${topicName}[${partitionId}]`)
      }
      if (options.requireReplicaSets && JSON.stringify(left.replicas) !== JSON.stringify(right.replicas)) {
        checks.replication = false
        failures.push(`Kafka replica set changed for ${topicName}[${partitionId}]`)
      }
    }
  }
  if (baseline.quorum.voterIds.join(',') !== current.quorum.voterIds.join(',')) {
    checks.controllerQuorum = false
    failures.push('Kafka controller voter IDs changed')
  }
  if (current.quorum.maxFollowerLag !== '0' || current.quorum.maxFollowerLagTimeMs !== '0') {
    checks.controllerQuorum = false
    failures.push('Kafka controller quorum has follower lag')
  }
  const baselineGroups = groupMap(baseline)
  const currentGroups = groupMap(current)
  const explicitGroups = new Set([...(options.requiredGroups ?? []), ...(options.exactGroups ?? [])])
  const groupNames = uniqueSorted([
    ...baseline.groups.map((group) => group.group),
    ...(options.requiredGroups ?? []),
    ...(options.exactGroups ?? []),
  ])
  for (const groupName of groupNames) {
    const before = baseline.groups.filter((group) => group.group === groupName)
    const after = current.groups.filter((group) => group.group === groupName)
    const explicitGroup = explicitGroups.has(groupName)
    if (before.length === 0) {
      checks.groupOffsets = false
      failures.push(`Required Kafka consumer group has no baseline offsets: ${groupName}`)
      continue
    }
    if (explicitGroup && before.some((group) => group.currentOffset === null)) {
      checks.groupOffsets = false
      failures.push(`Kafka explicit consumer group has null baseline committed offset: ${groupName}`)
    }
    if (explicitGroup && after.some((group) => group.currentOffset === null)) {
      checks.groupOffsets = false
      failures.push(`Kafka explicit consumer group has null current committed offset: ${groupName}`)
    }
    const beforeKeys = sorted(before.map(keyForGroupOffset))
    const afterKeys = sorted(after.map(keyForGroupOffset))
    if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
      checks.groupOffsets = false
      failures.push(`Kafka group offset partitions changed for ${groupName}`)
      continue
    }
    for (const key of beforeKeys) {
      const left = baselineGroups.get(key)
      const right = currentGroups.get(key)
      const exactGroup = options.exactGroups?.includes(groupName) ?? false
      const currentRegressed =
        !right ||
        compareOffsetValues(right.currentOffset, left?.currentOffset ?? null) < 0 ||
        compareOffsetValues(right.logEndOffset, left?.logEndOffset ?? null) < 0
      const exactChanged = exactGroup && (!right || right.currentOffset !== left?.currentOffset)
      const quiescedLogEndChanged =
        options.allowOffsetAdvance === false && (!right || right.logEndOffset !== left?.logEndOffset)
      if (!left || !right || currentRegressed || exactChanged || quiescedLogEndChanged) {
        checks.groupOffsets = false
        failures.push(`Kafka committed offset changed for ${key.replace('\u0000', '/')}`)
      }
    }
  }
  const storageFailures = storageNvmeFailures(current, options.requiredNodes ?? [])
  if (storageFailures.length > 0) {
    checks.nvmeStorage = false
    failures.push(...storageFailures)
  }
  if (
    current.topics.length !== 0 &&
    current.topics.some((topic) =>
      topic.partitions.some((partition) => partition.isr.length !== partition.replicas.length),
    )
  ) {
    warnings.push('Some current partitions are not fully in ISR; replication failures are already reported')
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    pass: failures.length === 0,
    baselineCapturedAt: baseline.capturedAt,
    currentCapturedAt: current.capturedAt,
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)],
    checks,
  }
}

const parseWitnessDocument = (value: unknown): RecordWitness[] => {
  const rows = Array.isArray(value) ? value : isObject(value) ? value.records : undefined
  if (!Array.isArray(rows)) throw new Error('Record witness must be an array or {records: []}')
  const witnesses: RecordWitness[] = []
  for (const row of rows) {
    if (!isObject(row)) throw new Error('Record witness row must be an object')
    const topic = stringValue(row.topic)
    const partition = numberValue(row.partition)
    const startOffset = stringValue(row.startOffset)
    const endOffset = stringValue(row.endOffset)
    const recordCount = numberValue(row.recordCount)
    const sha256 = stringValue(row.sha256)
    if (!topic || partition === null || !Number.isInteger(partition) || partition < 0 || !startOffset || !endOffset) {
      throw new Error('Record witness row has invalid topic, partition, or offset range')
    }
    if (
      recordCount === null ||
      !Number.isInteger(recordCount) ||
      recordCount < 0 ||
      !sha256 ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    ) {
      throw new Error(`Record witness row ${topic}[${partition}] has invalid count or SHA-256`)
    }
    witnesses.push({ topic, partition, startOffset, endOffset, recordCount, sha256: sha256.toLowerCase() })
  }
  const keys = witnesses.map((record) => keyForPartition(record.topic, record.partition))
  if (new Set(keys).size !== keys.length) throw new Error('Record witness contains duplicate topic/partition rows')
  return witnesses.sort((left, right) =>
    keyForPartition(left.topic, left.partition).localeCompare(keyForPartition(right.topic, right.partition)),
  )
}

const parseFileWitnessDocument = (value: unknown): FileWitness[] => {
  const rows = Array.isArray(value) ? value : isObject(value) ? value.files : undefined
  if (!Array.isArray(rows)) throw new Error('File witness must be an array or {files: []}')
  const witnesses: FileWitness[] = []
  for (const row of rows) {
    if (!isObject(row)) throw new Error('File witness row must be an object')
    const nodeId = numberValue(row.nodeId)
    const directoryId = stringValue(row.directoryId)
    const mountPath = stringValue(row.mountPath)
    const relativePath = stringValue(row.relativePath)
    const sizeBytes = textValue(row.sizeBytes)
    const sha256 = stringValue(row.sha256)
    if (
      nodeId === null ||
      !Number.isInteger(nodeId) ||
      nodeId < 0 ||
      !directoryId ||
      !mountPath ||
      !relativePath ||
      !sizeBytes ||
      !/^\d+$/.test(sizeBytes) ||
      !sha256 ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    ) {
      throw new Error('File witness row has invalid identity, size, or SHA-256')
    }
    witnesses.push({ nodeId, directoryId, mountPath, relativePath, sizeBytes, sha256: sha256.toLowerCase() })
  }
  const keys = witnesses.map(
    (file) => `${file.nodeId}\u0000${file.directoryId}\u0000${file.mountPath}\u0000${file.relativePath}`,
  )
  if (new Set(keys).size !== keys.length) throw new Error('File witness contains duplicate paths')
  return witnesses.sort((left, right) =>
    `${left.nodeId}\u0000${left.relativePath}`.localeCompare(`${right.nodeId}\u0000${right.relativePath}`),
  )
}

const readWitnesses = async (path: string) => parseWitnessDocument(JSON.parse(await readFile(path, 'utf8')) as unknown)

const readFileWitnesses = async (path: string) =>
  parseFileWitnessDocument(JSON.parse(await readFile(path, 'utf8')) as unknown)

const readNvmeEvidence = async (path: string): Promise<NvmeEvidence> => {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.nodes))
    throw new Error('Invalid NVMe evidence document')
  return value as unknown as NvmeEvidence
}

const readSnapshot = async (path: string): Promise<KafkaSnapshot> => {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION) throw new Error(`Invalid Kafka snapshot: ${path}`)
  return value as unknown as KafkaSnapshot
}

const writeJson = async (path: string, value: unknown) => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

const main = async () => {
  ensureCli('kubectl')
  const args = parseArgs(process.argv.slice(2))
  if (boolArg(args, 'help') || boolArg(args, 'h')) {
    console.log(usage())
    return
  }
  const mode = oneArg(args, 'mode') ?? 'capture'
  if (mode !== 'capture' && mode !== 'verify') fatal(`Invalid --mode: ${mode}`)
  const context = oneArg(args, 'context')
  if (!context) return fatal('Every capture requires an explicit --context; no implicit Kubernetes target is allowed')
  const namespace = oneArg(args, 'namespace') ?? DEFAULT_NAMESPACE
  const clusterName = oneArg(args, 'cluster') ?? 'kafka'
  const bootstrap = oneArg(args, 'bootstrap') ?? `${clusterName}-kafka-bootstrap:9093`
  const nvmeEvidencePath = oneArg(args, 'nvme-evidence')
  const nvmeEvidence = nvmeEvidencePath ? await readNvmeEvidence(nvmeEvidencePath) : undefined
  const snapshot = await collectSnapshot({
    context,
    namespace,
    clusterName,
    bootstrap,
    pod: oneArg(args, 'pod'),
    commandConfig: oneArg(args, 'command-config'),
    nvmeEvidence,
    allowEmptyTopics: boolArg(args, 'allow-empty-topics'),
  })
  if (mode === 'capture') {
    const output = oneArg(args, 'output')
    if (!output) return fatal('Capture mode requires --output')
    await writeJson(output, snapshot)
    console.log(`Kafka migration baseline captured: ${output}`)
    return
  }
  const baselinePath = oneArg(args, 'baseline')
  if (!baselinePath) return fatal('Verify mode requires --baseline')
  const beforeWitnessPath = oneArg(args, 'record-witness-before')
  const afterWitnessPath = oneArg(args, 'record-witness-after')
  if (!beforeWitnessPath || !afterWitnessPath) {
    return fatal(
      'Verify mode requires --record-witness-before and --record-witness-after; record counts alone are not proof',
    )
  }
  const fileWitnessBeforePath = oneArg(args, 'file-witness-before')
  const fileWitnessAfterPath = oneArg(args, 'file-witness-after')
  if (!fileWitnessBeforePath || !fileWitnessAfterPath) {
    return fatal('Verify mode requires --file-witness-before and --file-witness-after; file counts alone are not proof')
  }
  const baseline = await readSnapshot(baselinePath)
  const beforeWitnesses = await readWitnesses(beforeWitnessPath)
  const afterWitnesses = await readWitnesses(afterWitnessPath)
  const beforeFileWitnesses = await readFileWitnesses(fileWitnessBeforePath)
  const afterFileWitnesses = await readFileWitnesses(fileWitnessAfterPath)
  const options: VerificationOptions = {
    requireReplicaSets: boolArg(args, 'require-replica-sets'),
    requiredGroups: manyArgs(args, 'required-group'),
    exactGroups: manyArgs(args, 'exact-group'),
    requiredWitnessTopics: manyArgs(args, 'required-witness-topic'),
    requiredNodes: manyArgs(args, 'required-node'),
    allowOffsetAdvance: !boolArg(args, 'quiesced'),
  }
  const report = compareSnapshots(baseline, snapshot, options)
  const witnessFailures = [
    ...compareRecordWitnesses(beforeWitnesses, afterWitnesses),
    ...recordWitnessCoverageFailures(baseline, beforeWitnesses, options.requiredWitnessTopics ?? []),
  ]
  const fileWitnessFailures = [
    ...compareFileWitnesses(beforeFileWitnesses, afterFileWitnesses),
    ...fileWitnessCoverageFailures(baseline, beforeFileWitnesses, afterFileWitnesses),
  ]
  report.failures.push(...witnessFailures)
  report.failures.push(...fileWitnessFailures)
  report.failures = [...new Set(report.failures)]
  report.checks.recordWitnesses = witnessFailures.length === 0
  report.checks.fileWitnesses = fileWitnessFailures.length === 0
  report.pass = report.failures.length === 0
  const currentOutput = oneArg(args, 'current-output')
  if (currentOutput) await writeJson(currentOutput, snapshot)
  const output = oneArg(args, 'output')
  if (output) await writeJson(output, report)
  console.log(JSON.stringify(report, null, 2))
  if (!report.pass) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((error) => fatal('Kafka NVMe migration verification failed', error))
}
