import { describe, expect, test } from 'bun:test'

import { formatKubernetesMicroTime } from './leader-election'

describe('leader election lease timestamp formatting', () => {
  test('formats Kubernetes MicroTime values with six fractional digits', () => {
    expect(formatKubernetesMicroTime(new Date('2026-03-15T00:16:00.123Z'))).toBe('2026-03-15T00:16:00.123000Z')
    expect(formatKubernetesMicroTime(new Date('2026-03-15T00:16:00.000Z'))).toBe('2026-03-15T00:16:00.000000Z')
  })
})
