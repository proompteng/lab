import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitro/config'

const rootDir = dirname(fileURLToPath(import.meta.url))
const agentsRuntimePlugin = resolve(rootDir, 'server/plugins/agents-runtime')
const agentctlPlugin = resolve(rootDir, 'server/plugins/agentctl-grpc')
const controlPlaneCachePlugin = resolve(rootDir, 'server/plugins/control-plane-cache')
const h3AppAliasPlugin = resolve(rootDir, 'server/plugins/h3-app-alias')
const websocketResolverPlugin = resolve(rootDir, 'server/plugins/websocket-resolver')
const buildSourceMap = (() => {
  const value = process.env.JANGAR_BUILD_SOURCEMAP?.trim().toLowerCase()
  if (value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  return process.env.CI !== 'true'
})()

export default defineNitroConfig({
  preset: 'bun',
  serveStatic: true,
  minify: false,
  sourceMap: buildSourceMap,
  externals: {
    // Runtime images already include /app/node_modules, so skip nf3 tracing/copying work.
    noTrace: true,
    // Keep Start runtime internals inlined, but leave heavyweight SDKs external so Nitro
    // doesn't spend build time rebundling them on each image build.
    inline: ['@tanstack/react-start', '@tanstack/react-start-server', '@tanstack/start-server-core'],
  },
  experimental: {
    websocket: true,
  },
  plugins: [agentsRuntimePlugin, agentctlPlugin, controlPlaneCachePlugin, h3AppAliasPlugin, websocketResolverPlugin],
})
