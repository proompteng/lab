const requireValue = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const parseInteger = (value: string | undefined, fallback: number, name: string, minimum: number, maximum: number) => {
  if (!value?.trim()) return fallback
  const normalized = value.trim()
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

const parseUrl = (value: string, name: string, options: { allowClusterHttp?: boolean } = {}) => {
  const url = new URL(value)
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`)
  const localHttp = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const clusterHttp =
    options.allowClusterHttp === true && (url.hostname.endsWith('.svc') || url.hostname.endsWith('.svc.cluster.local'))
  if (url.protocol !== 'https:' && !localHttp && !clusterHttp) {
    throw new Error(`${name} must use https`)
  }
  return url
}

export type LinearMcpGatewayConfig = ReturnType<typeof resolveLinearMcpGatewayConfig>

export const resolveLinearMcpGatewayConfig = (env: NodeJS.ProcessEnv = process.env) => ({
  port: parseInteger(env.LINEAR_MCP_GATEWAY_PORT, 8080, 'LINEAR_MCP_GATEWAY_PORT', 1, 65_535),
  namespace: env.LINEAR_MCP_NAMESPACE?.trim() || 'agents',
  audience: env.LINEAR_MCP_TOKEN_AUDIENCE?.trim() || 'agents.proompteng.ai/linear-mcp',
  expectedServiceAccount: env.LINEAR_MCP_RUNNER_SERVICE_ACCOUNT?.trim() || 'codex-linear-runner',
  expectedAgent: env.LINEAR_MCP_AGENT_NAME?.trim() || 'codex-linear-agent',
  expectedProvider: env.LINEAR_MCP_PROVIDER_NAME?.trim() || 'codex-linear',
  triggerLabel: env.LINEAR_MCP_TRIGGER_LABEL?.trim().toLowerCase() || 'agentrun',
  maxRequestBytes: parseInteger(
    env.LINEAR_MCP_MAX_REQUEST_BYTES,
    256 * 1024,
    'LINEAR_MCP_MAX_REQUEST_BYTES',
    1024,
    1024 * 1024,
  ),
  upstreamTimeoutMs: parseInteger(
    env.LINEAR_MCP_UPSTREAM_TIMEOUT_MS,
    15_000,
    'LINEAR_MCP_UPSTREAM_TIMEOUT_MS',
    1000,
    60_000,
  ),
  readinessCacheMs: parseInteger(
    env.LINEAR_MCP_READINESS_CACHE_MS,
    15_000,
    'LINEAR_MCP_READINESS_CACHE_MS',
    1000,
    60_000,
  ),
  oauth: {
    clientId: requireValue(env, 'LINEAR_MCP_OAUTH_CLIENT_ID'),
    clientSecret: requireValue(env, 'LINEAR_MCP_OAUTH_CLIENT_SECRET'),
    actorId: requireValue(env, 'LINEAR_MCP_ACTOR_ID'),
    tokenUrl: parseUrl(
      env.LINEAR_MCP_OAUTH_TOKEN_URL?.trim() || 'https://api.linear.app/oauth/token',
      'LINEAR_MCP_OAUTH_TOKEN_URL',
    ),
    scopes: ['read', 'write'] as const,
  },
  upstreamUrl: parseUrl(env.LINEAR_MCP_UPSTREAM_URL?.trim() || 'https://mcp.linear.app/mcp', 'LINEAR_MCP_UPSTREAM_URL'),
})

export const resolveLinearMcpBridgeConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const tokenPath = requireValue(env, 'AGENTS_MCP_IDENTITY_TOKEN_PATH')
  if (!tokenPath.startsWith('/') || tokenPath === '/' || tokenPath.split('/').includes('..')) {
    throw new Error('AGENTS_MCP_IDENTITY_TOKEN_PATH must be an absolute path')
  }
  return {
    gatewayUrl: parseUrl(
      env.LINEAR_MCP_GATEWAY_URL?.trim() || 'http://agents-linear-mcp-gateway.agents.svc.cluster.local:8080/mcp',
      'LINEAR_MCP_GATEWAY_URL',
      { allowClusterHttp: true },
    ),
    tokenPath,
    timeoutMs: parseInteger(env.LINEAR_MCP_BRIDGE_TIMEOUT_MS, 30_000, 'LINEAR_MCP_BRIDGE_TIMEOUT_MS', 1000, 120_000),
  }
}
