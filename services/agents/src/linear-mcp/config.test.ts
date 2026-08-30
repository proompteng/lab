import { describe, expect, it } from 'vitest'

import { resolveLinearMcpBridgeConfig, resolveLinearMcpGatewayConfig } from './config'

describe('Linear MCP configuration', () => {
  it('defaults the gateway to the official HTTPS MCP and bounded identity contract', () => {
    const config = resolveLinearMcpGatewayConfig({
      LINEAR_MCP_OAUTH_CLIENT_ID: 'client-id',
      LINEAR_MCP_OAUTH_CLIENT_SECRET: 'client-secret',
      LINEAR_MCP_ACTOR_ID: 'actor-id',
    })

    expect(config.upstreamUrl.href).toBe('https://mcp.linear.app/mcp')
    expect(config.oauth.tokenUrl.href).toBe('https://api.linear.app/oauth/token')
    expect(config.oauth.scopes).toEqual(['read', 'write'])
    expect(config.audience).toBe('agents.proompteng.ai/linear-mcp')
  })

  it('allows plaintext only for the internal gateway and rejects unsafe token paths', () => {
    expect(
      resolveLinearMcpBridgeConfig({
        AGENTS_MCP_IDENTITY_TOKEN_PATH: '/var/run/secrets/agents-linear-mcp/token',
      }).gatewayUrl.href,
    ).toBe('http://agents-linear-mcp-gateway.agents.svc.cluster.local:8080/mcp')

    expect(() =>
      resolveLinearMcpBridgeConfig({
        AGENTS_MCP_IDENTITY_TOKEN_PATH: '/var/run/../stolen',
      }),
    ).toThrow('must be an absolute path')
    expect(() =>
      resolveLinearMcpBridgeConfig({
        AGENTS_MCP_IDENTITY_TOKEN_PATH: '/safe/token',
        LINEAR_MCP_GATEWAY_URL: 'http://agents-linear-mcp-gateway.svc.example.test/mcp',
      }),
    ).toThrow('must use https')
    expect(() =>
      resolveLinearMcpGatewayConfig({
        LINEAR_MCP_OAUTH_CLIENT_ID: 'client-id',
        LINEAR_MCP_OAUTH_CLIENT_SECRET: 'client-secret',
        LINEAR_MCP_ACTOR_ID: 'actor-id',
        LINEAR_MCP_UPSTREAM_URL: 'https://embedded:credential@mcp.linear.app/mcp',
      }),
    ).toThrow('must not contain credentials')
    expect(() =>
      resolveLinearMcpGatewayConfig({
        LINEAR_MCP_OAUTH_CLIENT_ID: 'client-id',
        LINEAR_MCP_OAUTH_CLIENT_SECRET: 'client-secret',
        LINEAR_MCP_ACTOR_ID: 'actor-id',
        LINEAR_MCP_GATEWAY_PORT: '8080http',
      }),
    ).toThrow('LINEAR_MCP_GATEWAY_PORT must be an integer')
  })
})
