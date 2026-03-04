import { afterEach, describe, expect, it } from 'vitest'

import { __private } from '~/server/codex-client'

describe('codex-client thread config', () => {
  afterEach(() => {
    delete process.env.JANGAR_MCP_URL
    delete process.env.UI_PORT
    delete process.env.PORT
  })

  it('does not set model reasoning summary', () => {
    const threadConfig = __private.resolveThreadConfig()
    expect(threadConfig).not.toHaveProperty('model_reasoning_summary')
  })

  it('uses explicit JANGAR_MCP_URL when provided', () => {
    process.env.JANGAR_MCP_URL = 'https://example.test/mcp'
    const threadConfig = __private.resolveThreadConfig()
    expect(threadConfig.mcp_servers.memories.url).toBe('https://example.test/mcp')
  })

  it('falls back to port-based mcp url when env override is missing', () => {
    process.env.UI_PORT = '9090'
    const threadConfig = __private.resolveThreadConfig()
    expect(threadConfig.mcp_servers.memories.url).toBe('http://127.0.0.1:9090/mcp')
  })
})
