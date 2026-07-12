import { describe, expect, it } from 'bun:test'

import { resolveGrafWaitTimeout } from './deploy-service'

describe('resolveGrafWaitTimeout', () => {
  it('preserves the duration unit expected by kn', () => {
    expect(resolveGrafWaitTimeout({ GRAF_KN_WAIT_TIMEOUT: '45s' })).toBe('45s')
  })

  it('defaults to a unit-bearing duration', () => {
    expect(resolveGrafWaitTimeout({})).toBe('300s')
  })
})
