import { describe, expect, test } from 'vitest'

import nitroConfig from '../../../nitro.config'

describe('nitro config', () => {
  test('serves static assets in production builds', () => {
    expect(nitroConfig.serveStatic).toBe(true)
  })

  test('enables websocket support', () => {
    expect(nitroConfig.experimental?.websocket).toBe(true)
  })

  test('disables nf3 node_modules tracing for container builds', () => {
    expect(nitroConfig.externals?.noTrace).toBe(true)
  })
})
