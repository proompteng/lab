import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const buildMinify = process.env.JANGAR_BUILD_MINIFY !== '0'
const backendPort = process.env.JANGAR_API_PORT ?? '3001'
const backendTarget = process.env.JANGAR_API_BASE_URL ?? `http://127.0.0.1:${backendPort}`
const includeTanStackDevtools = process.env.NODE_ENV !== 'production' && process.env.JANGAR_ENABLE_DEVTOOLS !== '0'
const reportCompressedSize = process.env.CI !== 'true'
const serverRoutePattern = /createFileRoute\(\s*(['"`])([^'"`]+)\1\s*\)/

const stubServerRoutesForClient = () => ({
  name: 'jangar-stub-server-routes-for-client',
  enforce: 'pre' as const,
  transform(code: string, id: string, options?: { ssr?: boolean }) {
    if (options?.ssr) return null
    if (!id.includes('/src/routes/')) return null
    if (!code.includes('server:')) return null

    const match = serverRoutePattern.exec(code)
    const routePath = match?.[2]
    if (!routePath) return null

    return {
      code: `
        import { createFileRoute } from '@tanstack/react-router'

        const ServerRoutePlaceholder = () => null

        export const Route = createFileRoute(${JSON.stringify(routePath)})({
          component: ServerRoutePlaceholder,
        })
      `,
      map: null,
    }
  },
})

const config = defineConfig({
  server: {
    allowedHosts: ['host.docker.internal', 'localhost-docker.internal', 'jangar', 'jangar.ide-newton.ts.net'],
    proxy: {
      '^/(api|health|mcp|openai|ready|v1)(?:/|$)': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: '.output/public',
    emptyOutDir: false,
    minify: buildMinify,
    cssMinify: buildMinify,
    reportCompressedSize,
  },
  plugins: [
    ...(includeTanStackDevtools ? [devtools()] : []),
    stubServerRoutesForClient(),
    viteTsConfigPaths({
      projects: ['./tsconfig.paths.json'],
    }),
    tailwindcss(),
    viteReact(),
  ],
})

export default config
