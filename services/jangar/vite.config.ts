import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const opentelemetryExternals = [
  '@opentelemetry/api',
  '@opentelemetry/auto-instrumentations-node',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-node',
  '@opentelemetry/semantic-conventions',
]

const ssrExternals = [...opentelemetryExternals, 'pg']

const config = defineConfig({
  server: {
    allowedHosts: ['host.docker.internal'],
  },
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
