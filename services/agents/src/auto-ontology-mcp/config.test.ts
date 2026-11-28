import { describe, expect, it } from 'vitest'

import { resolveAutoOntologyBridgeConfig, resolveAutoOntologyGatewayConfig } from './config'

const token = { AUTO_ONTOLOGY_API_TOKEN: 'auto_ontology_test' }
const projection = { AGENTS_MCP_IDENTITY_TOKEN_PATH: '/var/run/secrets/ontology/token' }

describe('Auto Ontology MCP config', () => {
  it('defaults to the authenticated frontend and leaves headroom in the bridge timeout', () => {
    const gateway = resolveAutoOntologyGatewayConfig(token)
    const bridge = resolveAutoOntologyBridgeConfig(projection)
    expect(gateway.upstream.url.href).toBe('http://frontend.auto-ontology.svc.cluster.local:3000/')
    expect(gateway.port).toBe(8080)
    expect(gateway.upstream.chatTimeoutMs).toBeLessThan(bridge.timeoutMs)
    expect(bridge.gatewayUrl.pathname).toBe('/mcp')
  })

  it('fails closed without a valid API token or a safe projection path', () => {
    expect(() => resolveAutoOntologyGatewayConfig({})).toThrow('AUTO_ONTOLOGY_API_TOKEN')
    expect(() => resolveAutoOntologyGatewayConfig({ AUTO_ONTOLOGY_API_TOKEN: 'invalid' })).toThrow()
    expect(() => resolveAutoOntologyBridgeConfig({})).toThrow('AGENTS_MCP_IDENTITY_TOKEN_PATH')
    expect(() => resolveAutoOntologyBridgeConfig({ AGENTS_MCP_IDENTITY_TOKEN_PATH: '/secrets/../etc/token' })).toThrow()
  })

  it.each([
    'http://auto-ontology.example.com',
    'https://user:secret@auto-ontology.example.com/',
    'https://auto-ontology.example.com/?token=secret',
    'ftp://frontend.auto-ontology.svc.cluster.local/',
  ])('rejects non-origin or unsafe upstream URL %s', (url) => {
    expect(() => resolveAutoOntologyGatewayConfig({ ...token, AUTO_ONTOLOGY_API_URL: url })).toThrow()
  })

  it('validates bounded timeouts and byte limits', () => {
    expect(() => resolveAutoOntologyGatewayConfig({ ...token, AUTO_ONTOLOGY_MCP_CHAT_TIMEOUT_MS: '120001' })).toThrow()
    expect(() => resolveAutoOntologyGatewayConfig({ ...token, AUTO_ONTOLOGY_MCP_MAX_REQUEST_BYTES: '0' })).toThrow()
    expect(
      resolveAutoOntologyBridgeConfig({ ...projection, AUTO_ONTOLOGY_MCP_BRIDGE_TIMEOUT_MS: '120000' }).timeoutMs,
    ).toBe(120_000)
  })
})
