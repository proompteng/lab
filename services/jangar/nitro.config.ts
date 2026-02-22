import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitro/config'

const rootDir = dirname(fileURLToPath(import.meta.url))
const agentsRuntimePlugin = resolve(rootDir, 'server/plugins/agents-runtime')
const agentctlPlugin = resolve(rootDir, 'server/plugins/agentctl-grpc')
const controlPlaneCachePlugin = resolve(rootDir, 'server/plugins/control-plane-cache')
const h3AppAliasPlugin = resolve(rootDir, 'server/plugins/h3-app-alias')
const websocketResolverPlugin = resolve(rootDir, 'server/plugins/websocket-resolver')
const knownUnusedExternalImportWarnings = [
  {
    exporter: '@tanstack/router-core/ssr/server',
    importer: '@tanstack/start-server-core/dist/esm/index.js',
    imports: [
      'createRequestHandler',
      'defineHandlerCallback',
      'transformPipeableStreamWithRouter',
      'transformReadableStreamWithRouter',
    ],
  },
  {
    exporter: '@tanstack/start-client-core',
    importer: '@tanstack/start-server-core/dist/esm/frame-protocol.js',
    imports: ['TSS_CONTENT_TYPE_FRAMED', 'TSS_FRAMED_PROTOCOL_VERSION'],
  },
]

const isKnownUnusedExternalImportWarning = (warning: { code?: string; message?: string }): boolean => {
  if (warning.code !== 'UNUSED_EXTERNAL_IMPORT') return false
  const message = warning.message ?? ''
  return knownUnusedExternalImportWarnings.some((knownWarning) => {
    return (
      message.includes(`external module "${knownWarning.exporter}"`) &&
      message.includes(knownWarning.importer) &&
      knownWarning.imports.every((importName) => message.includes(`"${importName}"`))
    )
  })
}

export default defineNitroConfig({
  preset: 'bun',
  serveStatic: true,
  minify: false,
  externals: {
    // Keep Start runtime internals inlined, but leave heavyweight SDKs external so Nitro
    // doesn't spend build time rebundling them on each image build.
    inline: ['@tanstack/react-start', '@tanstack/react-start-server', '@tanstack/start-server-core'],
  },
  experimental: {
    websocket: true,
  },
  rollupConfig: {
    onwarn(warning, warn) {
      if (isKnownUnusedExternalImportWarning(warning)) return
      warn(warning)
    },
  },
  plugins: [agentsRuntimePlugin, agentctlPlugin, controlPlaneCachePlugin, h3AppAliasPlugin, websocketResolverPlugin],
})
