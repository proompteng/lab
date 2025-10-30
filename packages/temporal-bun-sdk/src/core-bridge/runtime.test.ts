import { describe, expect, it } from 'bun:test'
import { native } from '../internal/core-bridge/native'
import { Runtime, type TemporalCoreLogEvent } from './runtime'

describe('Runtime.installLogger', () => {
  it('forwards log events to the registered callback', async () => {
    const runtime = Runtime.create()
    const events: Array<ReturnType<typeof buildEventSnapshot>> = []

    runtime.installLogger((event) => {
      events.push(buildEventSnapshot(event))
    })

    native.__TEST__.emitSyntheticLog({
      level: 'warn',
      target: 'core.runtime',
      message: 'forwarded',
      timestampMillis: 123,
      fieldsJson: '{"tenant":"alpha"}',
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      level: 'warn',
      levelIndex: 3,
      target: 'core.runtime',
      message: 'forwarded',
      timestampMillis: 123,
    })
    expect(events[0].fields).toEqual({ tenant: 'alpha' })

    runtime.removeLogger()
    await runtime.shutdown()
  })

  it('rejects duplicate registrations', async () => {
    const runtime = Runtime.create()

    runtime.installLogger(() => {})
    expect(() => runtime.installLogger(() => {})).toThrow(/already installed/i)

    runtime.removeLogger()
    await runtime.shutdown()
  })

  it('propagates logger errors and detaches the callback', async () => {
    const runtime = Runtime.create()
    const error = new Error('logger boom')

    runtime.installLogger(() => {
      throw error
    })

    expect(() => native.__TEST__.emitSyntheticLog({ message: 'first' })).toThrow(error)
    expect(() => native.__TEST__.emitSyntheticLog({ message: 'second' })).not.toThrow()

    runtime.removeLogger()
    await runtime.shutdown()
  })

  it('allows reinstalling a logger after the native bridge detaches it', async () => {
    const runtime = Runtime.create()

    runtime.installLogger(() => {
      throw new Error('logger failure')
    })

    expect(() => native.__TEST__.emitSyntheticLog({ message: 'first' })).toThrow()

    expect(() => runtime.installLogger(() => {})).not.toThrow()

    runtime.removeLogger()
    await runtime.shutdown()
  })
})

const buildEventSnapshot = (event: TemporalCoreLogEvent) => ({
  level: event.level,
  levelIndex: event.levelIndex,
  target: event.target,
  message: event.message,
  timestampMillis: event.timestampMillis,
  fieldsJson: event.fieldsJson,
  fields: event.fields,
})
