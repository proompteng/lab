import { describe, expect, it } from 'bun:test'

import { selectKafkaPodName } from '../tail-topic'

describe('Kafka tail topic helper', () => {
  it('prefers ready Strimzi broker pods over controller pods', () => {
    expect(
      selectKafkaPodName([
        {
          metadata: {
            name: 'kafka-pool-a-0',
            labels: {
              'strimzi.io/broker-role': 'false',
              'strimzi.io/controller-role': 'true',
            },
          },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
        {
          metadata: {
            name: 'kafka-pool-b-3',
            labels: {
              'strimzi.io/broker-role': 'true',
              'strimzi.io/controller-role': 'false',
            },
          },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ]),
    ).toBe('kafka-pool-b-3')
  })

  it('falls back to the first ready pool pod when role labels are absent', () => {
    expect(
      selectKafkaPodName([
        {
          metadata: { name: 'kafka-pool-a-0' },
          status: {
            phase: 'Pending',
            conditions: [{ type: 'Ready', status: 'False' }],
          },
        },
        {
          metadata: { name: 'kafka-pool-a-1' },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ]),
    ).toBe('kafka-pool-a-1')
  })
})
