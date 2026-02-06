import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitro/config'

const rootDir = dirname(fileURLToPath(import.meta.url))
const agentsRuntimePlugin = resolve(rootDir, 'server/plugins/agents-runtime')
const agentctlPlugin = resolve(rootDir, 'server/plugins/agentctl-grpc')
const controlPlaneCachePlugin = resolve(rootDir, 'server/plugins/control-plane-cache')
const h3AppAliasPlugin = resolve(rootDir, 'server/plugins/h3-app-alias')
const websocketResolverPlugin = resolve(rootDir, 'server/plugins/websocket-resolver')
export default defineNitroConfig({
  preset: 'bun',
  serveStatic: true,
  minify: false,
  externals: {
    inline: [
      '@tanstack/react-start',
      '@tanstack/react-start-server',
      '@tanstack/start-server-core',
      /^@aws-sdk\//,
      /^@smithy\//,
    ],
    traceInclude: ['@aws-sdk/core/protocols'],
  },
  experimental: {
    websocket: true,
  },
  plugins: [agentsRuntimePlugin, agentctlPlugin, controlPlaneCachePlugin, h3AppAliasPlugin, websocketResolverPlugin],
})
