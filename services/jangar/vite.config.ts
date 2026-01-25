import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import { rootRouteId } from '@tanstack/router-core'

const ssrExternals = ['kysely', 'nats', 'pg', 'node-pty']
const bunShimEnabled = process.env.JANGAR_BUN_SHIM === '1'
const bunShimPath = fileURLToPath(new URL('./src/server/bun-node-shim.ts', import.meta.url))
const buildMinify = process.env.JANGAR_BUILD_MINIFY !== '0'
const resolveAliases: Record<string, string> = bunShimEnabled ? { bun: bunShimPath } : {}

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
    tanstackStart(),
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
