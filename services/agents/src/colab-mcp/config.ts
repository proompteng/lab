import { z } from 'zod'

export const COLAB_AUDIENCE = 'agents.proompteng.ai/colab-mcp'
export const COLAB_GATEWAY_NAME = 'agents-colab-mcp-gateway'
export const COLAB_TOOL_TIMEOUT_MS = 630_000
export const COLAB_DISCOVERY_TIMEOUT_MS = 10_000

const positiveInteger = (fallback: number, max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(max)).prefault(String(fallback))

const gatewayEnv = z.object({
  COLAB_MCP_PORT: positiveInteger(8080, 65_535),
  COLAB_MCP_NAMESPACE: z.string().min(1).default('agents'),
  COLAB_MCP_CODEX_SERVICE_ACCOUNT: z.string().min(1).default('codex-auto-ontology-runner'),
  COLAB_MCP_ADC_PATH: z.string().startsWith('/').default('/var/run/secrets/colab-mcp-adc/credentials.json'),
  COLAB_QUOTA_PROJECT: z.string().trim().min(1).default('proompteng'),
  COLAB_MAX_CONCURRENT_RUNTIMES: positiveInteger(5, Number.MAX_SAFE_INTEGER),
})

export const resolveColabGatewayConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const config = gatewayEnv.parse(env)
  return {
    port: config.COLAB_MCP_PORT,
    namespace: config.COLAB_MCP_NAMESPACE,
    serviceAccountsByProvider: {
      codex: config.COLAB_MCP_CODEX_SERVICE_ACCOUNT,
      google: 'google-triage-runner',
    },
    adcPath: config.COLAB_MCP_ADC_PATH,
    quotaProject: config.COLAB_QUOTA_PROJECT,
    maxConcurrentRuntimes: config.COLAB_MAX_CONCURRENT_RUNTIMES,
  }
}

const bridgeEnv = z.object({
  COLAB_MCP_GATEWAY_URL: z
    .url()
    .transform((value) => new URL(value))
    .refine(
      (url) =>
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/mcp' &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            (url.hostname === 'localhost' ||
              url.hostname === '127.0.0.1' ||
              url.hostname.endsWith('.svc') ||
              url.hostname.endsWith('.svc.cluster.local')))),
      'Expected an HTTPS, Kubernetes Service, or localhost MCP URL without credentials',
    )
    .prefault(`http://${COLAB_GATEWAY_NAME}.agents.svc.cluster.local:8080/mcp`),
  COLAB_MCP_TOKEN_PATH: z.string().startsWith('/').default('/var/run/secrets/agents-colab-mcp/token'),
})

export const resolveColabBridgeConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const config = bridgeEnv.parse(env)
  return { gatewayUrl: config.COLAB_MCP_GATEWAY_URL, tokenPath: config.COLAB_MCP_TOKEN_PATH }
}
