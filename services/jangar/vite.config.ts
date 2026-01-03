import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const ssrExternals = ['kysely', 'nats', 'pg']
const bunShimEnabled = process.env.JANGAR_BUN_SHIM === '1'
const bunShimPath = fileURLToPath(new URL('./src/server/bun-node-shim.ts', import.meta.url))

const config = defineConfig({
  server: {
    allowedHosts: ['host.docker.internal'],
  },
  resolve: bunShimEnabled
    ? {
        alias: {
          bun: bunShimPath,
        },
      }
    : undefined,
  ssr: {
    external: ssrExternals,
  },
  build: {
    rollupOptions: {
      external: ssrExternals,
    },
  },
  plugins: [
    devtools(),
    nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
