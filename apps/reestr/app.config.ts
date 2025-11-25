import { defineConfig } from '@tanstack/start/config'
import viteTsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  vite: {
    plugins: [
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
    ],
  },
  routers: {
    client: {
      entry: './src/client.tsx',
    },
    ssr: {
      entry: './src/ssr.tsx',
    },
  },
  tsr: {
    appDirectory: './src',
    routesDirectory: './src/routes',
  },
})
