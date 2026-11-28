import { createMcpRunIdentityVerifier } from '../server/mcp-run-identity'
import { resolveAutoOntologyGatewayConfig } from './config'
import { createAutoOntologyGatewayHandler, GATEWAY_NAME } from './server'
import { createAutoOntologyUpstream } from './upstream'

const config = resolveAutoOntologyGatewayConfig()
const server = Bun.serve({
  port: config.port,
  idleTimeout: Math.ceil(config.upstream.chatTimeoutMs / 1000) + 20,
  maxRequestBodySize: config.maxRequestBytes,
  fetch: createAutoOntologyGatewayHandler({
    verify: createMcpRunIdentityVerifier({
      namespace: config.namespace,
      audience: config.audience,
      serviceAccountsByProvider: {
        codex: config.expectedServiceAccount,
        google: 'google-triage-runner',
      },
    }),
    upstream: createAutoOntologyUpstream(config.upstream),
    maxRequestBytes: config.maxRequestBytes,
  }),
})
console.info(`[${GATEWAY_NAME}] listening on port ${server.port}`)

const stop = () => void server.stop(false)
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
