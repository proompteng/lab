import { z } from 'zod'

const DEFAULT_API_URL = 'http://frontend.auto-ontology.svc.cluster.local:3000'
const DEFAULT_GATEWAY_URL = 'http://agents-auto-ontology-mcp-gateway.agents.svc.cluster.local:8080/mcp'

const integer = (fallback: number, min: number, max: number) =>
  z.string().trim().regex(/^\d+$/).transform(Number).pipe(z.int().min(min).max(max)).prefault(String(fallback))

const urlAt = (path: string) =>
  z
    .url()
    .transform((value) => new URL(value))
    .refine(
      (url) =>
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === path &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            (url.hostname === 'localhost' ||
              url.hostname === '127.0.0.1' ||
              url.hostname.endsWith('.svc') ||
              url.hostname.endsWith('.svc.cluster.local')))),
      'Expected a credential-free HTTPS, Kubernetes Service, or localhost HTTP URL',
    )

const gatewayEnv = z.object({
  AUTO_ONTOLOGY_API_TOKEN: z
    .string()
    .trim()
    .max(1024)
    .regex(/^auto_ontology_[A-Za-z0-9_-]+$/),
  AUTO_ONTOLOGY_API_URL: urlAt('/').prefault(DEFAULT_API_URL),
  AUTO_ONTOLOGY_MCP_PORT: integer(8080, 1, 65_535),
  AUTO_ONTOLOGY_MCP_NAMESPACE: z.string().trim().min(1).default('agents'),
  AUTO_ONTOLOGY_MCP_TOKEN_AUDIENCE: z.string().trim().min(1).default('agents.proompteng.ai/auto-ontology-mcp'),
  AUTO_ONTOLOGY_MCP_RUNNER_SERVICE_ACCOUNT: z.string().trim().min(1).default('codex-auto-ontology-runner'),
  AUTO_ONTOLOGY_MCP_MAX_REQUEST_BYTES: integer(32 * 1024, 1024, 256 * 1024),
  AUTO_ONTOLOGY_MCP_MAX_RESPONSE_BYTES: integer(1024 * 1024, 1024, 4 * 1024 * 1024),
  AUTO_ONTOLOGY_MCP_UPSTREAM_TIMEOUT_MS: integer(10_000, 1000, 30_000),
  AUTO_ONTOLOGY_MCP_CHAT_TIMEOUT_MS: integer(90_000, 1000, 150_000),
})

export const resolveAutoOntologyGatewayConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const config = gatewayEnv.parse(env)
  return {
    port: config.AUTO_ONTOLOGY_MCP_PORT,
    namespace: config.AUTO_ONTOLOGY_MCP_NAMESPACE,
    audience: config.AUTO_ONTOLOGY_MCP_TOKEN_AUDIENCE,
    expectedServiceAccount: config.AUTO_ONTOLOGY_MCP_RUNNER_SERVICE_ACCOUNT,
    maxRequestBytes: config.AUTO_ONTOLOGY_MCP_MAX_REQUEST_BYTES,
    upstream: {
      url: config.AUTO_ONTOLOGY_API_URL,
      token: config.AUTO_ONTOLOGY_API_TOKEN,
      maxResponseBytes: config.AUTO_ONTOLOGY_MCP_MAX_RESPONSE_BYTES,
      timeoutMs: config.AUTO_ONTOLOGY_MCP_UPSTREAM_TIMEOUT_MS,
      chatTimeoutMs: config.AUTO_ONTOLOGY_MCP_CHAT_TIMEOUT_MS,
    },
  }
}

const bridgeEnv = z.object({
  AUTO_ONTOLOGY_MCP_GATEWAY_URL: urlAt('/mcp').prefault(DEFAULT_GATEWAY_URL),
  AUTO_ONTOLOGY_MCP_BRIDGE_TIMEOUT_MS: integer(120_000, 1000, 180_000),
  AGENTS_MCP_IDENTITY_TOKEN_PATH: z
    .string()
    .trim()
    .refine(
      (path) => path.startsWith('/') && path !== '/' && !path.split('/').includes('..'),
      'Expected an absolute token file path',
    ),
})

export const resolveAutoOntologyBridgeConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const config = bridgeEnv.parse(env)
  return {
    gatewayUrl: config.AUTO_ONTOLOGY_MCP_GATEWAY_URL,
    timeoutMs: config.AUTO_ONTOLOGY_MCP_BRIDGE_TIMEOUT_MS,
    tokenPath: config.AGENTS_MCP_IDENTITY_TOKEN_PATH,
  }
}
