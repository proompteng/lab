import { describe, expect, it } from 'bun:test'

import { resolveGrafWaitTimeout } from './deploy-service'

describe('resolveGrafWaitTimeout', () => {
  it('normalizes a seconds suffix to the integer expected by kn', () => {
    expect(resolveGrafWaitTimeout({ GRAF_KN_WAIT_TIMEOUT: '45s' })).toBe('45')
  })

  it('preserves an integer seconds override', () => {
    expect(resolveGrafWaitTimeout({ GRAF_KN_WAIT_TIMEOUT: '90' })).toBe('90')
  })

  it('defaults to integer seconds', () => {
    expect(resolveGrafWaitTimeout({})).toBe('300')
  })

  it('rejects unsupported duration formats', () => {
    expect(() => resolveGrafWaitTimeout({ GRAF_KN_WAIT_TIMEOUT: '5m' })).toThrow(
      'GRAF_KN_WAIT_TIMEOUT must be a positive integer number of seconds',
    )
  })
})
