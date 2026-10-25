import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'

import { parseArgs, temporalCliTestHooks } from '../../src/bin/temporal-bun'
import { ObservabilityService, TemporalConfigService } from '../../src/runtime/effect-layers'
import { createObservabilityStub, createTestTemporalConfig } from '../helpers/observability'

describe('temporal-bun CLI parseArgs', () => {
  test('supports --flag=value syntax alongside positional args', () => {
    const { args, flags } = parseArgs([
      'doctor',
      '--log-format=json',
      '--metrics=file:/tmp/doctor.log',
      '--force',
    ])

    expect(args).toEqual(['doctor'])
    expect(flags['log-format']).toBe('json')
    expect(flags.metrics).toBe('file:/tmp/doctor.log')
    expect(flags.force).toBe(true)
  })

  test('continues to support space-delimited flags', () => {
    const { args, flags } = parseArgs(['docker-build', '--tag', 'worker:latest', '--context', './app'])

    expect(args).toEqual(['docker-build'])
    expect(flags.tag).toBe('worker:latest')
    expect(flags.context).toBe('./app')
  })
})

describe('temporal-bun doctor effect', () => {
  test('logs via injected observability services', async () => {
    const config = createTestTemporalConfig()
    const observability = createObservabilityStub()
    const layer = Layer.mergeAll(
      Layer.succeed(TemporalConfigService, config),
      Layer.succeed(ObservabilityService, observability.services),
    )

    await Effect.runPromise(Effect.provide(temporalCliTestHooks.handleDoctor([], {}), layer))

    expect(observability.logs.some((entry) => entry.message === 'temporal-bun doctor validation succeeded')).toBeTrue()
    expect(observability.getCounterIncrements()).toBe(1)
    expect(observability.getFlushes()).toBe(1)
  })
})
