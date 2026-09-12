import { Data } from 'effect'
import { topicPartitionKey } from './projection'

export class KafkaBootstrapFailure extends Data.TaggedError('KafkaBootstrapFailure')<{ readonly message: string }> {}

export enum KafkaBootstrapTimestampPolicy {
  ProducerClock = 'dorvud.producer-clock.v1',
  RetainedBeginning = 'retained-beginning',
}
export interface KafkaPartitionPosition {
  readonly topic: string
  readonly partition: number
  readonly offset: string
}
export interface KafkaBootstrapPartition {
  readonly topic: string
  readonly partition: number
  readonly logStartOffset: string
  readonly startOffset: string
  readonly endOffset: string
}
export interface KafkaBootstrapEvidence {
  readonly schemaVersion: 'bayn.kafka-bootstrap.v1'
  readonly epoch: string
  readonly observedAtMs: number
  readonly lowerTimestampMs: number
  readonly timestampPolicy: KafkaBootstrapTimestampPolicy
  readonly partitions: readonly KafkaBootstrapPartition[]
}
export const canonicalPositions = (positions: readonly KafkaPartitionPosition[]) =>
  positions.toSorted((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.partition - b.partition))
export const bootstrapKafkaPartitions = (
  starts: readonly KafkaPartitionPosition[],
  ends: readonly KafkaPartitionPosition[],
  seek: readonly KafkaPartitionPosition[],
): readonly KafkaBootstrapPartition[] => {
  const canonical = canonicalPositions(ends)
  const keys = canonical.map((position) => topicPartitionKey(position.topic, position.partition))
  if (
    keys.length === 0 ||
    new Set(keys).size !== keys.length ||
    [starts, seek].some(
      (positions) =>
        canonicalPositions(positions)
          .map((position) => topicPartitionKey(position.topic, position.partition))
          .join('|') !== keys.join('|'),
    )
  )
    throw new KafkaBootstrapFailure({ message: 'Kafka partition set changed during bootstrap' })
  return canonical.map((end, index) => {
    const start = canonicalPositions(starts)[index]
    const requested = canonicalPositions(seek)[index]
    if (start === undefined || requested === undefined)
      throw new KafkaBootstrapFailure({ message: 'Kafka bootstrap positions are missing' })
    const first = BigInt(start.offset)
    const last = BigInt(end.offset)
    const chosen = BigInt(requested.offset) === -1n ? last : BigInt(requested.offset)
    if (first < 0n || last < first || chosen < first || chosen > last)
      throw new KafkaBootstrapFailure({ message: 'Kafka retention or partition bounds changed during bootstrap' })
    return {
      topic: end.topic,
      partition: end.partition,
      logStartOffset: start.offset,
      startOffset: String(chosen),
      endOffset: end.offset,
    }
  })
}
export const kafkaBootstrapComplete = (
  evidence: KafkaBootstrapEvidence,
  positions: readonly KafkaPartitionPosition[],
) => {
  const current = new Map(
    positions.map((position) => [topicPartitionKey(position.topic, position.partition), BigInt(position.offset)]),
  )
  return (
    current.size === evidence.partitions.length &&
    evidence.partitions.every(
      (partition) =>
        (current.get(topicPartitionKey(partition.topic, partition.partition)) ?? -1n) >= BigInt(partition.endOffset),
    )
  )
}
