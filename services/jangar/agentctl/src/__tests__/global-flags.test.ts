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
})
