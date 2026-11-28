import { createMcpRunIdentityVerifier } from '../server/mcp-run-identity'
import { COLAB_AUDIENCE, COLAB_GATEWAY_NAME, resolveColabGatewayConfig } from './config'
import { createColabTokenProvider } from './oauth'
import { COLAB_MAX_REQUEST_BYTES, createColabGatewayHandler } from './server'
import { createColabUpstream } from './upstream'

const config = resolveColabGatewayConfig()
const tokens = createColabTokenProvider(config.adcPath)
const handle = createColabGatewayHandler({
  verify: createMcpRunIdentityVerifier({ ...config, audience: COLAB_AUDIENCE }),
  upstream: createColabUpstream({ tokens, quotaProject: config.quotaProject }),
  credentialsReady: tokens.credentialsReady,
  maxConcurrentRuntimes: config.maxConcurrentRuntimes,
})
const server = Bun.serve({
  port: config.port,
  maxRequestBodySize: COLAB_MAX_REQUEST_BYTES,
  fetch(request, server) {
    // execute_code can run for 600s. The upstream request has its own deadline.
    if (request.method === 'POST' && new URL(request.url).pathname === '/mcp') server.timeout(request, 0)
    return handle(request)
  },
})
console.info(`[${COLAB_GATEWAY_NAME}] listening on port ${server.port}`)

const stop = () => void server.stop(false)
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
