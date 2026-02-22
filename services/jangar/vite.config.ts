import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { rootRouteId } from '@tanstack/router-core'
import {
  type TanStackStartInputConfig,
  TanStackStartVitePluginCore,
  VITE_ENVIRONMENT_NAMES,
} from '@tanstack/start-plugin-core'
import { VIRTUAL_MODULES } from '@tanstack/start-server-core'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import path from 'pathe'
import { joinURL } from 'ufo'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const ssrExternals = ['kysely', 'nats', 'pg', 'node-pty']
const bunShimEnabled = process.env.JANGAR_BUN_SHIM === '1'
const bunShimPath = fileURLToPath(new URL('./src/server/bun-node-shim.ts', import.meta.url))
const buildMinify = process.env.JANGAR_BUILD_MINIFY !== '0'
const ssrCallerShimPath = fileURLToPath(new URL('./src/server/server-fn-ssr-caller.ts', import.meta.url))
const resolveAliases: Record<string, string> = {
  ...(bunShimEnabled ? { bun: bunShimPath } : {}),
  '@tanstack/start-server-core/server-fn-ssr-caller': ssrCallerShimPath,
}
const configDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(configDir, '../..')
const defaultEntryDir = path.resolve(repoRoot, 'node_modules/@tanstack/react-start/dist/plugin/default-entry')
const localEntryDir = path.resolve(configDir, 'node_modules/@tanstack/react-start/dist/plugin/default-entry')
const resolvedEntryDir = existsSync(defaultEntryDir) ? defaultEntryDir : localEntryDir
const defaultEntryPaths = {
  client: path.resolve(resolvedEntryDir, 'client.tsx'),
  server: path.resolve(resolvedEntryDir, 'server.ts'),
  start: path.resolve(resolvedEntryDir, 'start.ts'),
}
const isInsideRouterMonoRepo = path.basename(path.resolve(repoRoot, '..')) === 'packages'
const startManifestModuleId = `\0${VIRTUAL_MODULES.startManifest}`
const startClientEntryId = 'virtual:tanstack-start-client-entry'
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

const isFullUrl = (value: string): boolean => {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

const ensureRoutesManifestPlugin = () => ({
  name: 'jangar-ensure-start-routes-manifest',
  applyToEnvironment: (env: { name: string }) => env.name === VITE_ENVIRONMENT_NAMES.server || env.name === 'nitro',
  buildStart() {
    const routes = (
      globalThis as typeof globalThis & {
        TSS_ROUTES_MANIFEST?: Record<string, { filePath?: string; children?: string[] }>
      }
    ).TSS_ROUTES_MANIFEST
    if (!routes) return

    if (!routes[rootRouteId]) {
      routes[rootRouteId] = {
        children: Object.keys(routes),
      }
    }

    for (const route of Object.values(routes)) {
      if (route?.children) {
        route.children = route.children.filter((child) => Boolean(child && routes[child]))
      }
    }
  },
})

const nitroStartManifestPlugin = () => {
  let manifestSource: string | null = null
  let viteAppBase = '/'

  return {
    name: 'jangar-start-manifest-nitro',
    enforce: 'pre',
    applyToEnvironment: (env: { name: string }) => env.name === VITE_ENVIRONMENT_NAMES.server || env.name === 'nitro',
    configResolved(config: { base?: string }) {
      const base = config.base ?? '/'
      viteAppBase = isFullUrl(base) ? base : `/${base}`.replace(/\/{2,}/g, '/').replace(/\/?$/, '/')
    },
    resolveId(id: string) {
      if (id === VIRTUAL_MODULES.startManifest) {
        return startManifestModuleId
      }
    },
    load(id: string) {
      if (id !== startManifestModuleId || this.environment.name !== 'nitro') return
      if (this.environment.config.command === 'serve') {
        return `export const tsrStartManifest = () => ({
          routes: {},
          clientEntry: '${joinURL(viteAppBase, '@id', startClientEntryId)}',
        })`
      }
      if (!manifestSource) {
        const manifestDir = path.resolve(configDir, '.nitro/vite/services/ssr/assets')
        const manifestEntry = readdirSync(manifestDir, { withFileTypes: true }).find(
          (entry) => entry.isFile() && entry.name.startsWith('_tanstack-start-manifest_v-'),
        )
        if (!manifestEntry) {
          this.error('[jangar] Start manifest chunk not found for nitro build.')
        }
        manifestSource = readFileSync(path.join(manifestDir, manifestEntry.name), 'utf8')
      }
      return manifestSource
    },
  }
}

const tanstackStartNitro = (options?: TanStackStartInputConfig) => [
  {
    name: 'tanstack-react-start:config',
    configEnvironment(environmentName: string, envOptions: { resolve?: { noExternal?: boolean } } = {}) {
      return {
        resolve: {
          dedupe: ['react', 'react-dom', '@tanstack/react-start', '@tanstack/react-router'],
          external:
            envOptions.resolve?.noExternal === true || !isInsideRouterMonoRepo
              ? undefined
              : ['@tanstack/react-router', '@tanstack/react-router-devtools'],
        },
        optimizeDeps:
          environmentName === VITE_ENVIRONMENT_NAMES.client ||
          (environmentName === VITE_ENVIRONMENT_NAMES.server && options?.optimizeDeps?.noDiscovery === false)
            ? {
                exclude: [
                  '@tanstack/react-start',
                  '@tanstack/react-router',
                  '@tanstack/react-router-devtools',
                  '@tanstack/start-static-server-functions',
                ],
                include: [
                  'react',
                  'react/jsx-runtime',
                  'react/jsx-dev-runtime',
                  'react-dom',
                  ...(environmentName === VITE_ENVIRONMENT_NAMES.client ? ['react-dom/client'] : ['react-dom/server']),
                  '@tanstack/react-router > @tanstack/react-store',
                  ...(options?.optimizeDeps?.exclude?.find((entry) => entry === '@tanstack/react-form')
                    ? ['@tanstack/react-form > @tanstack/react-store']
                    : []),
                ],
              }
            : undefined,
      }
    },
  },
  ...TanStackStartVitePluginCore(
    {
      framework: 'react',
      defaultEntryPaths,
      serverFn: { providerEnv: VITE_ENVIRONMENT_NAMES.server },
    },
    options ?? {},
  ),
]

const config = defineConfig({
  server: {
    allowedHosts: ['host.docker.internal', 'localhost-docker.internal', 'jangar', 'jangar.ide-newton.ts.net'],
  },
  resolve: {
    alias: resolveAliases,
  },
  ssr: {
    external: ssrExternals,
    noExternal: ['@tanstack/react-start', '@tanstack/react-start-server', '@tanstack/start-server-core'],
  },
  build: {
    minify: buildMinify,
    cssMinify: buildMinify,
    rollupOptions: {
      external: ssrExternals,
      onwarn(warning, warn) {
        if (isKnownUnusedExternalImportWarning(warning)) return
        warn(warning)
      },
    },
  },
  plugins: [
    devtools(),
    nitroStartManifestPlugin(),
    ...tanstackStartNitro(),
    ensureRoutesManifestPlugin(),
    nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.paths.json'],
    }),
    tailwindcss(),
    viteReact(),
  ],
})

export default config
