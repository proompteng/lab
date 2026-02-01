import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import {
  TanStackStartVitePluginCore,
  VITE_ENVIRONMENT_NAMES,
  type TanStackStartInputConfig,
} from '@tanstack/start-plugin-core'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import { rootRouteId } from '@tanstack/router-core'
import path from 'pathe'

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
const defaultEntryPaths = {
  client: path.resolve(defaultEntryDir, 'client.tsx'),
  server: path.resolve(defaultEntryDir, 'server.ts'),
  start: path.resolve(defaultEntryDir, 'start.ts'),
}
const isInsideRouterMonoRepo = path.basename(path.resolve(repoRoot, '..')) === 'packages'

const ensureRoutesManifestPlugin = () => ({
  name: 'jangar-ensure-start-routes-manifest',
  applyToEnvironment: (env: { name: string }) => env.name === 'nitro',
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
      serverFn: { providerEnv: 'nitro' },
    },
    options ?? {},
  ),
]

const config = defineConfig({
  server: {
    allowedHosts: ['host.docker.internal'],
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
    },
  },
  plugins: [
    devtools(),
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
