import { describe, expect, it } from 'bun:test'
import { parseGlobalFlags } from '../cli/global-flags'

describe('parseGlobalFlags', () => {
  it('extracts flags and leaves remaining args', () => {
    const { argv, flags } = parseGlobalFlags(['--namespace', 'demo', '--grpc', 'run', 'list'])
    expect(flags.namespace).toBe('demo')
    expect(flags.grpc).toBe(true)
    expect(argv).toEqual(['run', 'list'])
  })

  it('parses output and short namespace', () => {
    const { argv, flags } = parseGlobalFlags(['-n', 'agents', '--output=json', 'status'])
    expect(flags.namespace).toBe('agents')
    expect(flags.output).toBe('json')
    expect(argv).toEqual(['status'])
  })

  it('parses confirmation and non-interactive flags', () => {
    const { argv, flags } = parseGlobalFlags(['--yes', '--no-input', 'delete', 'agent', 'demo'])
    expect(flags.yes).toBe(true)
    expect(flags.noInput).toBe(true)
    expect(argv).toEqual(['delete', 'agent', 'demo'])
  })

  it('preserves explicit negation and stops at the positional separator', () => {
    const { argv, flags } = parseGlobalFlags([
      '--tls',
      '--no-tls',
      '--address=fixture',
      '-o=json',
      'explain',
      '--',
      '--no-input',
    ])
    expect(flags).toEqual({ tls: false, address: 'fixture', output: 'json' })
    expect(argv).toEqual(['explain', '--', '--no-input'])
  })
})
