import { describe, expect, it } from 'vitest'

import { resolveTemporalAddress, temporalDefaultsFromEnv, withTemporalDefaults } from './shared'

const KEYS = [
  'TEMPORAL_ADDRESS',
  'TEMPORAL_HOST',
  'TEMPORAL_GRPC_PORT',
  'TEMPORAL_NAMESPACE',
  'TEMPORAL_TASK_QUEUE',
] as const

const setEnv = (values: Partial<Record<(typeof KEYS)[number], string | undefined>>) => {
  KEYS.forEach((key) => {
    const value = values[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  })
}

describe('shared temporal env helpers', () => {
  it('builds defaults from host and grpc port', () => {
    setEnv({
      TEMPORAL_HOST: 'temporal.internal',
      TEMPORAL_GRPC_PORT: '8233',
      TEMPORAL_NAMESPACE: 'default',
    })

    expect(resolveTemporalAddress()).toBe('temporal.internal:8233')
    expect(temporalDefaultsFromEnv()).toMatchObject({
      address: 'temporal.internal:8233',
      namespace: 'default',
      taskQueue: undefined,
    })
    expect(withTemporalDefaults(['workflow', 'start'])).toEqual([
      'workflow',
      'start',
      '--address',
      'temporal.internal:8233',
      '--namespace',
      'default',
    ])
  })

  it('prefers explicit address and preserves existing args', () => {
    setEnv({
      TEMPORAL_ADDRESS: 'explicit.temporal:1234',
      TEMPORAL_HOST: 'ignored.temporal',
      TEMPORAL_GRPC_PORT: '4321',
      TEMPORAL_NAMESPACE: 'ns',
      TEMPORAL_TASK_QUEUE: 'queue',
    })

    expect(withTemporalDefaults(['workflow', 'signal', '--address', 'provided'], true)).toEqual([
      'workflow',
      'signal',
      '--address',
      'provided',
      '--namespace',
      'ns',
      '--task-queue',
      'queue',
    ])
  })

  it('adds defaults only when values are present', () => {
    setEnv({
      TEMPORAL_NAMESPACE: 'ns',
      TEMPORAL_TASK_QUEUE: 'queue',
    })

    expect(withTemporalDefaults(['workflow', 'cancel'], false)).toEqual(['workflow', 'cancel', '--namespace', 'ns'])

    expect(withTemporalDefaults(['workflow', 'cancel'], true)).toEqual([
      'workflow',
      'cancel',
      '--namespace',
      'ns',
      '--task-queue',
      'queue',
    ])
  })
})
