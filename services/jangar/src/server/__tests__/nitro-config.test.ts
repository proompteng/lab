import { describe, expect, it, test } from 'vitest'

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

  it('registers torghut quant runtime bootstrap plugin', () => {
    const plugins = Array.isArray((nitroConfig as { plugins?: unknown }).plugins)
      ? ((nitroConfig as { plugins: unknown[] }).plugins as unknown[])
      : []

    const hasQuantRuntimePlugin = plugins.some(
      (plugin): plugin is string =>
        typeof plugin === 'string' && plugin.includes('server/plugins/torghut-quant-runtime'),
    )

    expect(hasQuantRuntimePlugin).toBe(true)
  })
})
