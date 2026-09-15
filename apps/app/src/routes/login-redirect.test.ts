import { describe, expect, it } from 'vitest'

import { resolveLoginNext } from './login-redirect'

describe('resolveLoginNext', () => {
  it('preserves path, query string, and hash', () => {
    expect(resolveLoginNext({ href: '/reports?window=1d#drawdown' })).toBe('/reports?window=1d#drawdown')
  })
})
