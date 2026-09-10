import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const ssrExternals = ['kysely', 'nats', 'node-pty', 'pg']
const buildSourceMap = (() => {
  const value = process.env.JANGAR_BUILD_SOURCEMAP?.trim().toLowerCase()
  if (value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  return process.env.CI !== 'true'
})()

export default defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ['./tsconfig.paths.json'],
    }),
    react(),
  ],
  resolve: {
    alias: {
      bun: 'bun',
    },
  },
  ssr: {
    external: ssrExternals,
  },
  build: {
    ssr: './src/server/index.ts',
    minify: false,
    sourcemap: buildSourceMap,
    emptyOutDir: false,
    outDir: '.output/server',
    rollupOptions: {
      external: (id) => ssrExternals.includes(id),
      output: {
        entryFileNames: 'index.mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
      },
    },
  },
})
