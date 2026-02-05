import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../config'

describe('resolveConfig', () => {
  it('defaults to kube mode even when address is set', () => {
    const { resolved, warnings } = resolveConfig({}, { address: '127.0.0.1:50051' })
    expect(resolved.mode).toBe('kube')
    expect(warnings.length).toBeGreaterThan(0)
  })
})
