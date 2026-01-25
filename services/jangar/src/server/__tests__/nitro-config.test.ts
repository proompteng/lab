import { describe, expect, test } from 'vitest'

import nitroConfig from '../../../nitro.config'

describe('nitro config', () => {
  test('serves static assets in production builds', () => {
    expect(nitroConfig.serveStatic).toBe(true)
  })
})
