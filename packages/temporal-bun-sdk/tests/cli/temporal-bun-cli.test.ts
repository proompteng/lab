import { describe, expect, test } from 'bun:test'
import { parseArgs } from '../../src/bin/temporal-bun'

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
