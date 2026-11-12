import { expect, test } from 'bun:test'

import { bootstrapKafkaPartitions, kafkaBootstrapComplete, KafkaBootstrapTimestampPolicy } from './bootstrap'

const position = (offset: string) => [{ topic: 'quotes', partition: 0, offset }]
const evidence = (partitions: ReturnType<typeof bootstrapKafkaPartitions>) => ({
  schemaVersion: 'bayn.kafka-bootstrap.v1' as const,
  epoch: 'append-race',
  observedAtMs: 1_000,
  lowerTimestampMs: 0,
  timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
  partitions,
})

test('a timestamp lookup after concurrent append starts at the original frozen end', () => {
  const frozenEnd = position('100')
  const partitions = bootstrapKafkaPartitions(position('10'), frozenEnd, position('150'))
  expect(partitions).toEqual([
    { topic: 'quotes', partition: 0, logStartOffset: '10', startOffset: '100', endOffset: '100' },
  ])
  expect(frozenEnd).toEqual(position('100'))
  expect(kafkaBootstrapComplete(evidence(partitions), position('99'))).toBe(false)
  expect(kafkaBootstrapComplete(evidence(partitions), position('100'))).toBe(true)
  // The consumer starts before the lookup's newer match, preserving every intervening append.
  expect(BigInt(partitions[0]?.startOffset ?? '-1')).toBeLessThan(150n)
})

test('a timestamp lookup with no match uses the captured end without another head lookup', () => {
  const partitions = bootstrapKafkaPartitions(position('10'), position('100'), position('-1'))
  expect(partitions[0]).toMatchObject({ startOffset: '100', endOffset: '100' })
  expect(kafkaBootstrapComplete(evidence(partitions), position('100'))).toBe(true)
  expect(kafkaBootstrapComplete(evidence(partitions), position('200'))).toBe(true)
})

test.each(['10', '50', '100'])('an existing seek at %s retains its original prefix', (offset) => {
  const [partition] = bootstrapKafkaPartitions(position('10'), position('100'), position(offset))
  expect(partition).toMatchObject({ startOffset: offset, endOffset: '100' })
})

test.each([
  ['-1', '100', '50'],
  ['10', '9', '150'],
  ['10', '100', '9'],
  ['0', '100', '-2'],
])('append clamping does not hide invalid retention bounds %s / %s / %s', (start, end, seek) => {
  expect(() => bootstrapKafkaPartitions(position(start), position(end), position(seek))).toThrow('retention')
})

test('a changed partition inventory still fails closed during timestamp lookup', () => {
  expect(() => bootstrapKafkaPartitions(position('10'), position('100'), [])).toThrow('partition set')
})
